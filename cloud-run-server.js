import http from "node:http";
import fs from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { WebSocket, WebSocketServer } from "ws";
import { requireFirebaseUser } from "./functions/firebase-auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const routes = {
  "/api/chat": "./functions/api/chat.js",
  "/api/chat/sync": "./functions/api/chat-sync.js",
  "/api/chat/backup": "./functions/api/chat-backup.js",
  "/api/video": "./functions/api/video.js",
  "/api/firebase-config": "./functions/api/firebase-config.js",
  "/api/models": "./functions/api/models.js",
  "/api/plugins": "./functions/api/plugins.js",
  "/api/plugins/connect": "./functions/api/plugins-connect.js",
  "/api/plugins/disconnect": "./functions/api/plugins-disconnect.js",
  "/api/files/upload": "./functions/api/files-upload.js",
  "/api/files/process": "./functions/api/files-process.js",
  "/api/push/config": "./functions/api/push/config.js",
  "/api/push/register": "./functions/api/push/register.js",
  "/api/push/unregister": "./functions/api/push/unregister.js"
};

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".apk": "application/vnd.android.package-archive"
  }[ext] || "application/octet-stream";
}

function forwardedOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "http")
    .split(",")[0]
    .trim() || "http";
  const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`)
    .split(",")[0]
    .trim();
  return `${forwardedProto}://${forwardedHost}`;
}

function createRuntimeEnv(req) {
  const env = { ...process.env };
  if (!env.TRUX_APP_ORIGIN) env.TRUX_APP_ORIGIN = forwardedOrigin(req);
  return env;
}

async function loadHandler(modulePath) {
  return import(path.resolve(__dirname, modulePath));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function makeRequest(req, body, signal = null) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "http")
    .split(",")[0]
    .trim() || "http";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value != null) headers.set(key, value);
  }

  const init = {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    ...(signal ? { signal } : {})
  };
  if (body instanceof ReadableStream) init.duplex = "half";
  return new Request(`${forwardedProto}://${host}${req.url}`, init);
}

function contextFor(request, env) {
  // Cloud Run handles the live request/stream directly; no background-task shim.
  return { request, env, params: {} };
}

async function sendResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) return res.end();

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  res.end();
}

async function handleApi(req, res, route, pathname) {
  const requestController = new AbortController();
  const abortRequest = () => {
    if (!requestController.signal.aborted) requestController.abort();
  };
  const onRequestClose = () => {
    if (!req.complete) abortRequest();
  };
  const onResponseClose = () => {
    if (!res.writableEnded) abortRequest();
  };

  req.on("aborted", abortRequest);
  req.on("close", onRequestClose);
  res.on("close", onResponseClose);

  try {
    const mod = await loadHandler(route);
    const streamingUpload = pathname === "/api/files/upload";
    const body = req.method === "GET" || req.method === "HEAD"
      ? undefined
      : (streamingUpload ? Readable.toWeb(req) : await readBody(req));
    const request = makeRequest(req, body, requestController.signal);
    const context = contextFor(request, createRuntimeEnv(req));
    let response;

    if (req.method === "GET" && mod.onRequestGet) response = await mod.onRequestGet(context);
    else if (req.method === "POST" && mod.onRequestPost) response = await mod.onRequestPost(context);
    else if (req.method === "OPTIONS") response = new Response(null, { status: 204 });
    else response = new Response("Method Not Allowed", { status: 405 });

    await sendResponse(res, response);
  } catch (error) {
    if (requestController.signal.aborted) {
      try { res.end(); } catch {}
      return;
    }
    console.error("API route failed:", error);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const detail = String(error?.message || error || "Unknown error.");
    res.end(JSON.stringify({
      error: "Internal server error",
      detail
    }));
  } finally {
    req.off("aborted", abortRequest);
    req.off("close", onRequestClose);
    res.off("close", onResponseClose);
  }
}

async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relative);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.statusCode = 400;
    return res.end("Bad Request");
  }

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    res.statusCode = 200;
    res.setHeader("Content-Type", mimeType(filePath));
    /* The application shell must never be stored by an intermediate CDN,
       browser cache, or proxy. JS/CSS/image assets may remain cacheable. */
    const extension = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath).toLowerCase();
    if (extension === ".html" || basename === "sw.js") {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch {
    /* Missing assets must stay 404s. Returning index.html for a missing
       JS/CSS/image request masks deployment errors and can break the browser
       with an "Unexpected token <" script failure. */
    const extension = path.extname(filePath).toLowerCase();
    const acceptsHtml = String(req.headers.accept || "").includes("text/html");
    const isNavigation = req.method === "GET" && acceptsHtml && !extension;
    if (!isNavigation) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.end("Not Found");
    }
    const indexPath = path.join(PUBLIC_DIR, "index.html");
    try {
      await fs.promises.access(indexPath, fs.constants.R_OK);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      return fs.createReadStream(indexPath).pipe(res);
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.end("Application shell unavailable");
    }
  }
}


/*
 * Authenticated native Live bridge.
 * Native clients must first send {"type":"auth","token":"Firebase ID token"}.
 * Screen capture/audio only flow after the user has granted Android's OS dialogs.
 */
const liveSocketServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 2 * 1024 * 1024
});

let liveGoogleProjectPromise = null;
async function getLiveGoogleProjectId() {
  const fromEnv = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (fromEnv) return fromEnv;
  if (!liveGoogleProjectPromise) {
    liveGoogleProjectPromise = fetch("http://metadata.google.internal/computeMetadata/v1/project/project-id", {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(4000)
    }).then(async response => {
      if (!response.ok) throw new Error("Could not determine the Google Cloud project for Live.");
      const projectId = (await response.text()).trim();
      if (!projectId) throw new Error("Google Cloud project ID was empty.");
      return projectId;
    }).catch(error => {
      liveGoogleProjectPromise = null;
      throw error;
    });
  }
  return liveGoogleProjectPromise;
}

function safeLiveSocketSend(socket, packet) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try { return socket.send(JSON.stringify(packet)), true; }
  catch { return false; }
}

liveSocketServer.on("connection", socket => {
  let isAuthenticated = false;
  let isConnecting = false;
  let liveSession = null;
  let closed = false;
  const authTimer = setTimeout(() => {
    if (!isAuthenticated) {
      safeLiveSocketSend(socket, { type: "error", message: "Live authentication timed out." });
      socket.close(1008, "Authentication required");
    }
  }, 12000);

  const closeLiveSession = () => {
    if (closed) return;
    closed = true;
    clearTimeout(authTimer);
    try { liveSession?.close(); } catch {}
    liveSession = null;
  };

  socket.on("message", async (raw, isBinary) => {
    try {
      if (isBinary) throw new Error("Live expects JSON media packets.");
      const packet = JSON.parse(raw.toString("utf8"));
      if (!isAuthenticated) {
        if (packet.type !== "auth" || typeof packet.token !== "string" || packet.token.length < 20) {
          safeLiveSocketSend(socket, { type: "error", message: "Authenticate with a valid TruX account first." });
          socket.close(1008, "Authentication required");
          return;
        }
        // Reuse the app's existing Firebase ID-token verifier.
        await requireFirebaseUser(new Request("https://trux-live.invalid/", {
          headers: { authorization: "Bearer " + packet.token }
        }));
        isAuthenticated = true;
        clearTimeout(authTimer);
        if (closed || socket.readyState !== WebSocket.OPEN) return;
        isConnecting = true;
        safeLiveSocketSend(socket, { type: "connecting" });

        const project = await getLiveGoogleProjectId();
        if (closed || socket.readyState !== WebSocket.OPEN) return;
        const ai = new GoogleGenAI({
          vertexai: true,
          project,
          location: process.env.TRUX_LIVE_LOCATION || "global"
        });
        liveSession = await ai.live.connect({
          model: process.env.TRUX_LIVE_MODEL || "gemini-live-2.5-flash-native-audio",
          config: {
            responseModalities: ["AUDIO"],
            systemInstruction: "You are TruX Live, a helpful real-time voice assistant. Listen carefully to the user's speech and use provided screen frames only to answer their request. Speak naturally and concisely, ask clarifying questions when needed, and do not claim to have clicked, changed, or accessed anything you have not actually done. Respect user privacy."
          },
          callbacks: {
            onmessage(message) {
              if (closed || socket.readyState !== WebSocket.OPEN) return;
              const serverContent = message?.serverContent || message?.server_content;
              const parts = serverContent?.modelTurn?.parts || serverContent?.model_turn?.parts || [];
              for (const part of parts) {
                const inline = part?.inlineData || part?.inline_data;
                if (inline?.data) safeLiveSocketSend(socket, {
                  type: "audio",
                  data: inline.data,
                  mimeType: inline.mimeType || inline.mime_type || "audio/pcm;rate=24000"
                });
                if (part?.text) safeLiveSocketSend(socket, { type: "transcript", role: "assistant", text: part.text });
              }
              const inputTranscript = serverContent?.inputTranscription?.text || serverContent?.input_transcription?.text;
              const outputTranscript = serverContent?.outputTranscription?.text || serverContent?.output_transcription?.text;
              if (inputTranscript) safeLiveSocketSend(socket, { type: "transcript", role: "user", text: inputTranscript });
              if (outputTranscript) safeLiveSocketSend(socket, { type: "transcript", role: "assistant", text: outputTranscript });
              if (serverContent?.interrupted) safeLiveSocketSend(socket, { type: "interrupted" });
              if (serverContent?.turnComplete || serverContent?.turn_complete) safeLiveSocketSend(socket, { type: "turnComplete" });
            },
            onerror(error) {
              safeLiveSocketSend(socket, { type: "error", message: String(error?.message || "Gemini Live connection error.") });
            },
            onclose(event) {
              safeLiveSocketSend(socket, { type: "ended", reason: String(event?.reason || "") });
            }
          }
        });
        isConnecting = false;
        if (closed || socket.readyState !== WebSocket.OPEN) {
          try { liveSession.close(); } catch {}
          liveSession = null;
          return;
        }
        safeLiveSocketSend(socket, { type: "ready", model: process.env.TRUX_LIVE_MODEL || "gemini-live-2.5-flash-native-audio" });
        return;
      }

      if (!liveSession) {
        if (isConnecting) return;
        throw new Error("The Live session is not ready.");
      }
      if (packet.type === "audio" && typeof packet.data === "string") {
        liveSession.sendRealtimeInput({
          audio: { data: packet.data, mimeType: "audio/pcm;rate=16000" }
        });
      } else if (packet.type === "video" && typeof packet.data === "string") {
        // Gemini Live accepts screen/video frames as individual images (up to 1 fps).
        liveSession.sendRealtimeInput({
          video: { data: packet.data, mimeType: "image/jpeg" }
        });
      } else if (packet.type === "text" && typeof packet.text === "string") {
        liveSession.sendRealtimeInput({ text: packet.text.slice(0, 4000) });
      } else if (packet.type === "stop") {
        safeLiveSocketSend(socket, { type: "ended", reason: "User stopped Live." });
        closeLiveSession();
        try { socket.close(1000, "User stopped Live"); } catch {}
      }
    } catch (error) {
      safeLiveSocketSend(socket, {
        type: "error",
        message: isAuthenticated ? String(error?.message || "Live session failed.") : "TruX could not verify your account. Please sign in again."
      });
      if (!isAuthenticated) {
        try { socket.close(1008, "Authentication failed"); } catch {}
      }
    }
  });

  socket.on("close", closeLiveSession);
  socket.on("error", closeLiveSession);
});


const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname.startsWith("/api/")) {
    const route = routes[pathname];
    if (!route) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "API route not found" }));
    }
    return handleApi(req, res, route, pathname);
  }
  return serveStatic(req, res);
});

// TruX-Code may legitimately run for a long time. Cloud Run controls the
// service request lifetime; do not add a shorter Node-level request/socket limit.
server.requestTimeout = 0;
server.timeout = 0;


server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try { pathname = new URL(req.url || "/", "http://localhost").pathname; } catch {}
  if (pathname !== "/api/live") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  liveSocketServer.handleUpgrade(req, socket, head, client => {
    liveSocketServer.emit("connection", client, req);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TruX-AI Cloud Run server listening on ${PORT}`);
});
