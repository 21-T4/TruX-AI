import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, "public");

const routes = {
  "/api/chat": "./functions/api/chat.js",
  "/api/video": "./functions/api/video.js",
  "/api/firebase-config": "./functions/api/firebase-config.js",
  "/api/background/start": "./functions/api/background/start.js",
  "/api/background/status": "./functions/api/background/status.js",
  "/api/background/update": "./functions/api/background/update.js",
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

  /*
   * Cloudflare Queues are not available inside a normal Cloud Run container.
   * Expose a small compatibility adapter so the existing background route can
   * keep the same interface. The job is started after the HTTP response path
   * returns, and the existing worker code performs the status persistence.
   */
  env.TRUX_BACKGROUND_QUEUE = {
    async send(payload) {
      Promise.resolve().then(async () => {
        try {
          const worker = await import("./workers/trux-background.js");
          if (!worker?.default?.queue) throw new Error("Cloud Run background worker is unavailable.");
          await worker.default.queue(
            { messages: [{ body: payload }] },
            env
          );
        } catch (error) {
          console.error("Cloud Run background job failed:", error);
        }
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

function makeRequest(req, body) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "http")
    .split(",")[0]
    .trim() || "http";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value != null) headers.set(key, value);
  }

  return new Request(`${forwardedProto}://${host}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
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

async function handleApi(req, res, route) {
  try {
    const mod = await loadHandler(route);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const request = makeRequest(req, body);
    const context = contextFor(request, createRuntimeEnv(req));
    let response;

    if (req.method === "GET" && mod.onRequestGet) response = await mod.onRequestGet(context);
    else if (req.method === "POST" && mod.onRequestPost) response = await mod.onRequestPost(context);
    else if (req.method === "OPTIONS") response = new Response(null, { status: 204 });
    else response = new Response("Method Not Allowed", { status: 405 });

    await sendResponse(res, response);
  } catch (error) {
    console.error("API route failed:", error);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const detail = String(error?.message || error || "Unknown server error.");
    res.end(JSON.stringify({
      error: "Internal server error",
      detail
    }));
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
    return handleApi(req, res, route);
  }
  return serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TruX-AI Cloud Run server listening on ${PORT}`);
});
