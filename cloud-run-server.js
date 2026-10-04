import http from "node:http";
import fs from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  "/api/files/upload": "./functions/api/files-upload.js",
  "/api/files/process": "./functions/api/files-process.js",
  "/api/background/start": "./functions/api/background/start.js",
  "/api/background/status": "./functions/api/background/status.js",
  "/api/background/update": "./functions/api/background/update.js",
  "/api/background/cancel": "./functions/api/background/cancel.js",
  "/api/background/execute": "./functions/api/background/execute.js",
  "/api/github/apply-edits": "./functions/api/github/apply-edits.js",
  "/api/github/authorize": "./functions/api/github/authorize.js",
  "/api/github/callback": "./functions/api/github/callback.js",
  "/api/github/commit": "./functions/api/github/commit.js",
  "/api/github/disconnect": "./functions/api/github/disconnect.js",
  "/api/github/repos": "./functions/api/github/repos.js",
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
    ".txt": "text/plain; charset=utf-8"
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
  // Background work stays inside the Cloud Run container. Avoid public-domain
  // routing so Cloudflare/browser connectivity cannot interrupt the worker.
  env.TRUX_BACKGROUND_ORIGIN = env.TRUX_BACKGROUND_ORIGIN || ('http://127.0.0.1:' + PORT);

  /*
   * Cloud Run cannot reliably keep a detached promise alive after the
   * /api/background/start request finishes. Dispatch a second HTTP request
   * to a dedicated worker endpoint instead. That request owns the long-running
   * 20-minute job independently of the original browser request.
   */
  env.TRUX_BACKGROUND_QUEUE = {
    async send(payload) {
      const target = new URL("/api/background/execute", env.TRUX_BACKGROUND_ORIGIN);
      const client = target.protocol === "https:" ? (await import("node:https")).default : (await import("node:http")).default;
      const body = JSON.stringify(payload);

      await new Promise((resolve, reject) => {
        const req = client.request({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: target.pathname + target.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "X-TruX-Background-Secret": String(payload?.jobSecret || "")
          }
        }, res => {
          res.on("data", () => {});
          res.on("end", () => {});
        });

        req.on("error", reject);

        /*
         * The payload is fully handed to the network as soon as the request
         * finishes writing. Do not wait for the worker's 20-minute response.
         */
        req.on("finish", resolve);
        req.end(body);
      });
    }
  };

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
  return {
    request,
    env,
    params: {},
    waitUntil(promise) {
      Promise.resolve(promise).catch(error => console.error("waitUntil failed:", error));
    }
  };
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
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch {
    const indexPath = path.join(PUBLIC_DIR, "index.html");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    fs.createReadStream(indexPath).pipe(res);
  }
}

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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TruX-AI Cloud Run server listening on ${PORT}`);
});
