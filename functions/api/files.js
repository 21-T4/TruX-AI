import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PDFParse } from 'pdf-parse';
import unzipper from 'unzipper';
import path from 'node:path';
import { downloadBuffer, getBucket, processedMetaKey, processedTextKey, userFileKey } from '../../gcs-store.js';
import { requireFirebaseUser } from '../../firebase-auth.js';

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

async function handleUpload({ request, env }) {
  const user = await requireFirebaseUser(request, env);
  const name = decodeURIComponent(String(request.headers.get('x-trux-file-name') || 'upload.bin')).slice(0, 200);
  const mimeType = String(request.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  const declaredSize = Number(request.headers.get('content-length') || 0);

  if (!request.body) {
    return Response.json({ error: 'File body is missing.' }, { status: 400 });
  }
  if (declaredSize > MAX_UPLOAD_BYTES) {
    return Response.json({ error: 'Files are limited to 30 MB.' }, { status: 413 });
  }

  const objectKey = userFileKey(user.uid, name);
  const target = getBucket(env).file(objectKey);
  let total = 0;

  const limiter = new Transform({
    transform(chunk, enc, callback) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        callback(new Error('Files are limited to 30 MB.'));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(
      Readable.fromWeb(request.body),
      limiter,
      target.createWriteStream({
        resumable: false,
        validation: 'crc32c',
        metadata: {
          contentType: mimeType,
          metadata: { ownerUid: user.uid, originalName: name }
        }
      })
    );
  } catch (error) {
    try { await target.delete({ ignoreNotFound: true }); } catch {}
    const status = /limited to 30 MB/i.test(String(error?.message)) ? 413 : 500;
    return Response.json({ error: status === 413 ? error.message : 'Upload failed.' }, { status });
  }

  return Response.json({
    ok: true,
    objectKey,
    name,
    size: total,
    mimeType
  });
}

const MAX_PROCESS_BYTES = 30 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 5_000_000;
const MAX_ZIP_FILES = 1500;
const MAX_ZIP_FILE_BYTES = 800_000;
const IGNORED_DIRS = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|target|vendor)(\/|$)/i;
const TEXT_EXTS = new Set([
  'txt','md','markdown','json','csv','log','js','jsx','ts','tsx','html','css','xml','py',
  'java','c','cpp','h','hpp','cs','go','rs','sql','sh','yaml','yml','toml','ini','env',
  'vue','svelte','php','rb','swift','kt','kts','dart'
]);

function extension(name) {
  return path.extname(String(name || '')).toLowerCase().replace(/^\./, '');
}

function looksText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let zeros = 0;
  for (const b of sample) if (b === 0) zeros++;
  return zeros === 0;
}

function clip(text) {
  const value = String(text || '').replace(/\r\n?/g, '\n');
  return value.length > MAX_EXTRACTED_CHARS ? value.slice(0, MAX_EXTRACTED_CHARS) + '\n\n[Extraction capped at 5,000,000 characters.]' : value;
}

async function extractPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return {
      kind: 'pdf',
      text: clip(result?.text || ''),
      pages: Array.isArray(result?.pages) ? result.pages.length : null
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractZip(buffer) {
  const directory = await unzipper.Open.buffer(buffer);
  const chunks = [];
  let included = 0;
  let skipped = 0;

  for (const entry of directory.files.slice(0, MAX_ZIP_FILES)) {
    const entryPath = String(entry.path || '');
    if (!entryPath || entry.type === 'Directory' || IGNORED_DIRS.test(entryPath)) {
      skipped++;
      continue;
    }
    const ext = extension(entryPath);
    if (!TEXT_EXTS.has(ext) || Number(entry.uncompressedSize || 0) > MAX_ZIP_FILE_BYTES) {
      skipped++;
      continue;
    }

    try {
      const data = await entry.buffer();
      if (!looksText(data)) {
        skipped++;
        continue;
      }
      const text = data.toString('utf8').replace(/\u0000/g, '');
      chunks.push(`--- FILE: ${entryPath} ---\n${text}\n`);
      included++;
      if (chunks.join('\n').length >= MAX_EXTRACTED_CHARS) break;
    } catch {
      skipped++;
    }
  }

  return {
    kind: 'codebase',
    text: clip(chunks.join('\n')),
    filesIncluded: included,
    filesSkipped: skipped
  };
}

async function extractFile(buffer, name, mimeType) {
  const ext = extension(name);
  if (ext === 'pdf' || mimeType === 'application/pdf') return extractPdf(buffer);
  if (ext === 'zip' || mimeType === 'application/zip') return extractZip(buffer);

  if (TEXT_EXTS.has(ext) || mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('csv')) {
    if (!looksText(buffer)) throw new Error('The uploaded file does not look like text data.');
    const text = buffer.toString('utf8').replace(/\u0000/g, '');
    const csv = ext === 'csv' || mimeType.includes('csv');
    const rows = csv ? text.split(/\n/).filter(Boolean).length : null;
    return { kind: csv ? 'csv' : 'text', text: clip(text), rows };
  }

  throw new Error('This file type cannot be text-processed yet. PDF, CSV, ZIP codebases, and common text/code formats are supported.');
}

async function handleProcess({ request, env }) {
  const user = await requireFirebaseUser(request, env);
  const body = await request.json();
  const objectKey = String(body?.objectKey || '');

  if (!objectKey.startsWith(`users/${user.uid}/files/`)) {
    return Response.json({ error: 'That file does not belong to this account.' }, { status: 403 });
  }

  const file = getBucket(env).file(objectKey);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata?.size || 0);
  if (size > MAX_PROCESS_BYTES) {
    return Response.json({ error: 'Files are limited to 30 MB for processing.' }, { status: 413 });
  }

  const buffer = await downloadBuffer(env, objectKey);
  const originalName = String(metadata?.metadata?.originalname || metadata?.metadata?.originalName || path.basename(objectKey));
  const mimeType = String(metadata?.contentType || body?.mimeType || 'application/octet-stream');

  let extracted;
  try {
    extracted = await extractFile(buffer, originalName, mimeType);
  } catch (error) {
    return Response.json({ error: String(error?.message || 'File processing failed.') }, { status: 422 });
  }

  const textKey = processedTextKey(user.uid, objectKey);
  await getBucket(env).file(textKey).save(Buffer.from(extracted.text, 'utf8'), {
    resumable: false,
    validation: 'crc32c',
    metadata: { contentType: 'text/plain; charset=utf-8', cacheControl: 'private, no-store' }
  });

  const meta = {
    version: 1,
    objectKey,
    name: originalName,
    mimeType,
    size,
    kind: extracted.kind,
    pages: extracted.pages ?? null,
    rows: extracted.rows ?? null,
    filesIncluded: extracted.filesIncluded ?? null,
    filesSkipped: extracted.filesSkipped ?? null,
    processedAt: new Date().toISOString(),
    textKey
  };
  await getBucket(env).file(processedMetaKey(user.uid, objectKey)).save(
    Buffer.from(JSON.stringify(meta), 'utf8'),
    { resumable: false, validation: 'crc32c', metadata: { contentType: 'application/json', cacheControl: 'private, no-store' } }
  );

  return Response.json({
    ok: true,
    file: {
      objectKey,
      processedKey: textKey,
      name: originalName,
      mimeType,
      size,
      kind: meta.kind,
      pages: meta.pages,
      rows: meta.rows,
      filesIncluded: meta.filesIncluded,
      filesSkipped: meta.filesSkipped,
      snippet: `${originalName} · ${meta.kind.toUpperCase()} · ${Math.ceil(size / 1024)} KB`
    }
  });
}

export async function onRequestPost(context) {
  const pathname = new URL(context.request.url).pathname;
  if (pathname === '/api/files/upload') return handleUpload(context);
  if (pathname === '/api/files/process') return handleProcess(context);
  return new Response('Not Found', { status: 404 });
}
