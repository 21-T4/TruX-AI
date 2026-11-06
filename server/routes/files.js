/* Uploads (streamed to GCS, 30 MB cap) and text extraction for attachments. */
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PDFParse } from 'pdf-parse';
import unzipper from 'unzipper';
import { requireUser } from '../lib/firebase.js';
import { HttpError, json, readJson } from '../lib/http.js';
import { assertOwnedKey, downloadBuffer, getBucket, processedMetaKey, processedTextKey, saveBuffer, userFileKey } from '../lib/storage.js';

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 5_000_000;
const MAX_ZIP_FILES = 1500;
const MAX_ZIP_FILE_BYTES = 800_000;
const IGNORED_DIRS = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|target|vendor)(\/|$)/i;
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'log', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'xml', 'py',
  'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'sql', 'sh', 'yaml', 'yml', 'toml', 'ini',
  'vue', 'svelte', 'php', 'rb', 'swift', 'kt', 'kts', 'dart'
]);
const ALLOWED_UPLOAD = /^(image\/(png|jpeg|webp|gif|heic|heif)|application\/(pdf|zip|x-zip-compressed|json|octet-stream)|text\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|video\/(mp4|webm|quicktime))$/i;

const ext = name => path.extname(String(name || '')).toLowerCase().replace(/^\./, '');
const looksText = buffer => !buffer.subarray(0, 4096).includes(0);
const clip = text => {
  const value = String(text || '').replace(/\r\n?/g, '\n');
  return value.length > MAX_EXTRACTED_CHARS ? value.slice(0, MAX_EXTRACTED_CHARS) + '\n\n[Extraction capped at 5,000,000 characters.]' : value;
};

async function extractPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { kind: 'pdf', text: clip(result?.text || ''), pages: Array.isArray(result?.pages) ? result.pages.length : null };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractZip(buffer) {
  const directory = await unzipper.Open.buffer(buffer);
  const chunks = [];
  let included = 0, skipped = 0, size = 0;
  for (const entry of directory.files.slice(0, MAX_ZIP_FILES)) {
    const entryPath = String(entry.path || '');
    if (!entryPath || entry.type === 'Directory' || IGNORED_DIRS.test(entryPath) || entryPath.includes('..') ||
        !TEXT_EXTS.has(ext(entryPath)) || Number(entry.uncompressedSize || 0) > MAX_ZIP_FILE_BYTES) { skipped++; continue; }
    try {
      const data = await entry.buffer();
      if (!looksText(data)) { skipped++; continue; }
      const block = `--- FILE: ${entryPath} ---\n${data.toString('utf8')}\n`;
      chunks.push(block); included++; size += block.length;
      if (size >= MAX_EXTRACTED_CHARS) break;
    } catch { skipped++; }
  }
  return { kind: 'codebase', text: clip(chunks.join('\n')), filesIncluded: included, filesSkipped: skipped };
}

async function extractFile(buffer, name, mimeType) {
  const e = ext(name);
  if (e === 'pdf' || mimeType === 'application/pdf') return extractPdf(buffer);
  if (e === 'zip' || /zip/.test(mimeType)) return extractZip(buffer);
  if (TEXT_EXTS.has(e) || mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('csv')) {
    if (!looksText(buffer)) throw new HttpError(422, 'The uploaded file does not look like text data.');
    const text = buffer.toString('utf8');
    const csv = e === 'csv' || mimeType.includes('csv');
    return { kind: csv ? 'csv' : 'text', text: clip(text), rows: csv ? text.split('\n').filter(Boolean).length : null };
  }
  throw new HttpError(422, 'This file type cannot be read as text. PDF, CSV, ZIP codebases and common text/code files are supported.');
}

async function upload(request) {
  const user = await requireUser(request, { limit: { name: 'upload', capacity: 20, refillPerSecond: 0.2 } });
  let name;
  try { name = decodeURIComponent(String(request.headers.get('x-trux-file-name') || 'upload.bin')).slice(0, 200); }
  catch { name = 'upload.bin'; }
  const mimeType = String(request.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_UPLOAD.test(mimeType)) throw new HttpError(415, 'This file type is not supported.');
  if (Number(request.headers.get('content-length') || 0) > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Files are limited to 30 MB.');
  if (!request.body) throw new HttpError(400, 'File body is missing.');

  const objectKey = userFileKey(user.uid, name);
  const target = (await getBucket()).file(objectKey);
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _enc, callback) {
      total += chunk.length;
      callback(total > MAX_UPLOAD_BYTES ? new HttpError(413, 'Files are limited to 30 MB.') : null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(request.body), limiter, target.createWriteStream({
      resumable: false,
      validation: 'crc32c',
      metadata: { contentType: mimeType, metadata: { ownerUid: user.uid, originalName: name } }
    }));
  } catch (error) {
    await target.delete({ ignoreNotFound: true }).catch(() => {});
    throw error?.status ? error : new HttpError(500, 'Upload failed.');
  }
  return json({ ok: true, objectKey, name, size: total, mimeType });
}

async function processFile(request) {
  const user = await requireUser(request, { limit: { name: 'process', capacity: 20, refillPerSecond: 0.2 } });
  const body = await readJson(request, 8 * 1024);
  const objectKey = assertOwnedKey(user.uid, body?.objectKey, ['files']);
  const file = (await getBucket()).file(objectKey);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata?.size || 0);
  if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Files are limited to 30 MB.');
  const originalName = String(metadata?.metadata?.originalName || path.basename(objectKey));
  const mimeType = String(metadata?.contentType || 'application/octet-stream');
  const extracted = await extractFile(await downloadBuffer(objectKey), originalName, mimeType);
  const textKey = processedTextKey(user.uid, objectKey);
  const meta = {
    objectKey, name: originalName, mimeType, size, kind: extracted.kind,
    pages: extracted.pages ?? null, rows: extracted.rows ?? null,
    filesIncluded: extracted.filesIncluded ?? null, filesSkipped: extracted.filesSkipped ?? null,
    processedAt: new Date().toISOString()
  };
  await Promise.all([
    saveBuffer(textKey, Buffer.from(extracted.text, 'utf8'), 'text/plain; charset=utf-8'),
    saveBuffer(processedMetaKey(user.uid, objectKey), Buffer.from(JSON.stringify(meta)), 'application/json')
  ]);
  return json({ ok: true, file: { ...meta, snippet: `${originalName} · ${meta.kind.toUpperCase()} · ${Math.ceil(size / 1024)} KB` } });
}

export const routes = {
  'POST /api/files/upload': upload,
  'POST /api/files/process': processFile
};
