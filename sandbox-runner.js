import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 8080);
const MAX_CODE_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 200_000;

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readBody(req, maxBytes = 120_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function runProcess(command, args, cwd, timeoutMs, maxOutputChars) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: {
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: cwd,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PYTHONNOUSERSITE: '1',
        NODE_NO_WARNINGS: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const append = (target, chunk) => {
      const next = target + chunk.toString('utf8');
      return next.length > maxOutputChars ? next.slice(0, maxOutputChars) + '\n[output truncated]' : next;
    };

    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.min(Math.max(1000, timeoutMs), DEFAULT_TIMEOUT_MS));

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: typeof code === 'number' ? code : null,
        signal: signal || null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr
      });
    });

    child.on('error', error => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: String(error?.message || 'Execution failed.')
      });
    });
  });
}

async function execute(payload) {
  const language = String(payload?.language || '').toLowerCase();
  const code = String(payload?.code || '');
  const timeoutMs = Number(payload?.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxOutputChars = Math.min(Number(payload?.maxOutputChars || MAX_OUTPUT_CHARS), MAX_OUTPUT_CHARS);

  if (!['python', 'node'].includes(language)) throw new Error('Unsupported language.');
  if (!code.trim()) throw new Error('Code is empty.');
  if (code.length > MAX_CODE_CHARS) throw new Error('Code is limited to 100,000 characters.');

  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'trux-sandbox-'));
  const source = path.join(workdir, language === 'python' ? 'main.py' : 'main.mjs');

  try {
    await fs.writeFile(source, code, { encoding: 'utf8', mode: 0o600 });
    return await runProcess(
      language === 'python' ? 'python3' : 'node',
      [source],
      workdir,
      timeoutMs,
      maxOutputChars
    );
  } finally {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || new URL(req.url || '/', 'http://localhost').pathname !== '/execute') {
    return json(res, 404, { error: 'Not found.' });
  }

  try {
    const body = JSON.parse(await readBody(req));
    const result = await execute(body);
    return json(res, 200, result);
  } catch (error) {
    return json(res, 400, { error: String(error?.message || 'Execution failed.') });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('TruX-AI sandbox runner listening on ' + PORT);
});
