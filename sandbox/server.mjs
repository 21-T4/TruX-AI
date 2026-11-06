/*
 * TruX sandbox service.
 *
 * Runs shell commands and drives a headless Chromium for the assistant.
 * Only the TruX app's service account may call it (Cloud Run IAM plus an ID
 * token check here, so code inside the sandbox cannot call itself).
 * Each chat gets its own workspace owned by its own Linux user, so sessions
 * cannot read each other's files. Idle sessions are deleted after 30 minutes.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { OAuth2Client } from 'google-auth-library';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.PORT || 8080);
const ALLOWED_CALLER = String(process.env.ALLOWED_CALLER || '').toLowerCase();
const ROOT = '/work';
const IDLE_MS = 30 * 60 * 1000;
const MAX_OUTPUT = 30_000;
const MAX_FILE = 20 * 1024 * 1024;
const VIEWPORT = { width: 1280, height: 800 };
const auth = new OAuth2Client();
const IS_ROOT = process.getuid?.() === 0;

const sessions = new Map(); // sid -> { dir, uid, lastUsed, context, page }
let browserPromise = null;

/* ---------- helpers ---------- */
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const clip = (text, max = MAX_OUTPUT) => {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max / 2) + `\n…[${s.length - max} characters cut]…\n` + s.slice(-max / 2) : s;
};
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html',
  '.zip': 'application/zip', '.py': 'text/x-python', '.js': 'text/javascript'
};

async function authorize(req) {
  if (!ALLOWED_CALLER) return true; // local development
  const header = String(req.headers.authorization || req.headers['x-serverless-authorization'] || '');
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  try {
    const ticket = await auth.verifyIdToken({ idToken: token });
    const payload = ticket.getPayload() || {};
    return payload.email_verified && String(payload.email).toLowerCase() === ALLOWED_CALLER;
  } catch { return false; }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('Request too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function session(sid) {
  if (!/^[a-f0-9]{16,64}$/.test(String(sid || ''))) throw Object.assign(new Error('Invalid session.'), { status: 400 });
  let s = sessions.get(sid);
  if (!s) {
    const uid = 20000 + (parseInt(sid.slice(0, 8), 16) % 40000);
    const dir = path.join(ROOT, sid);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chown(dir, uid, uid).catch(() => {});
    s = { dir, uid, lastUsed: Date.now(), context: null, page: null };
    sessions.set(sid, s);
  }
  s.lastUsed = Date.now();
  return s;
}

function insideWorkspace(s, file) {
  const resolved = path.resolve(s.dir, String(file || '').replace(/^\/work\/[a-f0-9]+\/?/, ''));
  if (resolved !== s.dir && !resolved.startsWith(s.dir + path.sep)) throw Object.assign(new Error('Path is outside the workspace.'), { status: 400 });
  return resolved;
}

async function recentFiles(dir, since, limit = 40) {
  const out = [];
  async function walk(current, depth) {
    if (depth > 4 || out.length >= limit) return;
    let entries = [];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else {
        const stat = await fs.stat(full).catch(() => null);
        if (stat && stat.mtimeMs >= since) out.push({ path: path.relative(dir, full), size: stat.size });
      }
      if (out.length >= limit) return;
    }
  }
  await walk(dir, 0);
  return out;
}

/* ---------- shell ---------- */
async function exec(s, { command, timeout = 60 }) {
  const cmd = String(command || '').slice(0, 20_000);
  if (!cmd.trim()) throw Object.assign(new Error('Empty command.'), { status: 400 });
  const limit = Math.min(Math.max(Number(timeout) || 60, 1), 280) * 1000;
  const started = Date.now() - 50;
  return new Promise(resolve => {
    const child = spawn('bash', ['-lc', cmd], {
      cwd: s.dir,
      ...(IS_ROOT ? { uid: s.uid, gid: s.uid } : {}),
      detached: true,
      env: {
        HOME: s.dir, USER: 'trux', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:' + s.dir + '/.local/bin',
        LANG: 'C.UTF-8', TERM: 'dumb', NODE_PATH: '/app/node_modules', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
        PIP_USER: '1', PYTHONUSERBASE: s.dir + '/.local', PIP_BREAK_SYSTEM_PACKAGES: '1', npm_config_prefix: s.dir + '/.local'
      }
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', d => { if (stdout.length < MAX_OUTPUT * 4) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < MAX_OUTPUT * 4) stderr += d; });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, limit);
    child.on('close', async code => {
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      resolve({
        exitCode: timedOut ? null : code,
        timedOut,
        stdout: clip(stdout),
        stderr: clip(stderr, 12_000),
        workspace: s.dir,
        changedFiles: await recentFiles(s.dir, started)
      });
    });
  });
}

async function readFile(s, { path: file }) {
  const full = insideWorkspace(s, file);
  const stat = await fs.stat(full).catch(() => null);
  if (!stat?.isFile()) throw Object.assign(new Error('File not found: ' + file), { status: 404 });
  if (stat.size > MAX_FILE) throw Object.assign(new Error('File is larger than 20 MB.'), { status: 413 });
  const data = await fs.readFile(full);
  return { name: path.basename(full), size: stat.size, mimeType: MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', data: data.toString('base64') };
}

/* ---------- browser ---------- */
const BLOCKED_HOST = /^(localhost|metadata(\.google\.internal)?|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cd])/i;

async function page(s) {
  if (!browserPromise) {
    browserPromise = chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] }).catch(error => { browserPromise = null; throw error; });
  }
  const browser = await browserPromise;
  if (!s.context || !browser.isConnected()) {
    s.context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, acceptDownloads: false });
    await s.context.route('**/*', route => {
      let host = '';
      try { host = new URL(route.request().url()).hostname; } catch {}
      return BLOCKED_HOST.test(host) ? route.abort('blockedbyclient') : route.continue();
    });
    s.page = await s.context.newPage();
  }
  if (s.page.isClosed()) s.page = await s.context.newPage();
  return s.page;
}

function locate(p, step) {
  if (step.selector) return p.locator(String(step.selector)).first();
  if (step.text) return p.getByText(String(step.text), { exact: false }).first();
  if (step.role) return p.getByRole(String(step.role), step.name ? { name: String(step.name) } : {}).first();
  throw new Error('Give a selector, text or role.');
}

async function browse(s, { actions = [], fullPage = false }) {
  const p = await page(s);
  const log = [];
  for (const step of (Array.isArray(actions) ? actions : []).slice(0, 25)) {
    const type = String(step?.type || '');
    try {
      switch (type) {
        case 'goto': {
          let url = String(step.url || '');
          if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
          await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await p.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
          break;
        }
        case 'click':
          if (Number.isFinite(step.x) && Number.isFinite(step.y)) await p.mouse.click(step.x, step.y);
          else await locate(p, step).click({ timeout: 10_000 });
          await p.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
          break;
        case 'fill': await locate(p, step).fill(String(step.value ?? step.textValue ?? ''), { timeout: 10_000 }); break;
        case 'type': await p.keyboard.type(String(step.value ?? ''), { delay: 15 }); break;
        case 'press': await p.keyboard.press(String(step.key || 'Enter')); await p.waitForTimeout(400); break;
        case 'scroll': await p.mouse.wheel(0, Number(step.y) || 700); await p.waitForTimeout(300); break;
        case 'wait': await p.waitForTimeout(Math.min(Number(step.ms) || 1000, 10_000)); break;
        case 'back': await p.goBack({ timeout: 15_000 }).catch(() => {}); break;
        case 'evaluate': log.push({ type, result: clip(JSON.stringify(await p.evaluate(String(step.script || 'null'))), 8000) }); continue;
        default: throw new Error('Unknown action ' + type);
      }
      log.push({ type, ok: true });
    } catch (error) {
      log.push({ type, ok: false, error: String(error?.message || error).split('\n')[0].slice(0, 300) });
    }
  }
  const shot = await p.screenshot({ type: 'jpeg', quality: 72, fullPage: !!fullPage && (await p.evaluate(() => document.body?.scrollHeight || 0)) < 12_000 });
  const text = await p.evaluate(() => (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n')).catch(() => '');
  const links = await p.evaluate(() => [...document.querySelectorAll('a[href]')].slice(0, 40).map(a => ({ text: a.innerText.trim().slice(0, 80), href: a.href })).filter(l => l.text)).catch(() => []);
  return { url: p.url(), title: await p.title().catch(() => ''), text: clip(text, 8000), links, log, screenshot: { mimeType: 'image/jpeg', data: shot.toString('base64') } };
}

async function reset(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid);
  await s.context?.close().catch(() => {});
  await fs.rm(s.dir, { recursive: true, force: true }).catch(() => {});
}

setInterval(() => {
  for (const [sid, s] of sessions) if (Date.now() - s.lastUsed > IDLE_MS) reset(sid);
}, 5 * 60 * 1000).unref();

/* ---------- server ---------- */
const ROUTES = {
  '/exec': (s, body) => exec(s, body),
  '/file': (s, body) => readFile(s, body),
  '/browser': (s, body) => browse(s, body)
};

http.createServer(async (req, res) => {
  if (req.url === '/healthz') return send(res, 200, { ok: true });
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only.' });
  if (!(await authorize(req))) return send(res, 401, { error: 'Unauthorized.' });
  try {
    const body = await readBody(req);
    if (req.url === '/reset') { await reset(String(body.sid || '')); return send(res, 200, { ok: true }); }
    const handler = ROUTES[req.url];
    if (!handler) return send(res, 404, { error: 'Not found.' });
    send(res, 200, await handler(await session(body.sid), body));
  } catch (error) {
    send(res, error.status || 500, { error: String(error?.message || error).slice(0, 500) });
  }
}).listen(PORT, () => {
  fs.mkdir(ROOT, { recursive: true, mode: 0o711 }).catch(() => {});
  console.log('TruX sandbox listening on ' + PORT + (ALLOWED_CALLER ? '' : ' (no caller check: local mode)'));
});

process.on('SIGTERM', async () => {
  for (const sid of sessions.keys()) await reset(sid);
  process.exit(0);
});
