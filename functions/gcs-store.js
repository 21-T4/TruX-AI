import { Storage } from '@google-cloud/storage';
import crypto from 'node:crypto';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(gzipCallback);
let storageInstance = null;

function projectId(env = {}) {
  return String(
    env.GCP_PROJECT_ID ||
    env.GOOGLE_CLOUD_PROJECT ||
    env.GCLOUD_PROJECT ||
    env.PROJECT_ID ||
    ''
  ).trim() || undefined;
}

export function bucketName(env = {}) {
  return String(env.TRUX_BUCKET_NAME || 'trux-ai-bucket').trim();
}

export function getStorage(env = {}) {
  if (!storageInstance) storageInstance = new Storage({ projectId: projectId(env) });
  return storageInstance;
}

export function getBucket(env = {}) {
  return getStorage(env).bucket(bucketName(env));
}

export function safeFileName(name) {
  return String(name || 'upload.bin')
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'upload.bin';
}

export function userFileKey(uid, fileName) {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `users/${uid}/files/${yyyy}/${mm}/${dd}/${crypto.randomUUID()}-${safeFileName(fileName)}`;
}

export async function objectExists(env, objectKey) {
  const [exists] = await getBucket(env).file(objectKey).exists();
  return exists;
}

export async function saveGzipJson(env, objectKey, value) {
  const body = Buffer.from(JSON.stringify(value));
  const compressed = await gzip(body, { level: 6 });
  await getBucket(env).file(objectKey).save(compressed, {
    resumable: false,
    validation: 'crc32c',
    metadata: {
      contentType: 'application/json',
      contentEncoding: 'gzip',
      cacheControl: 'private, no-store'
    }
  });
  return compressed.length;
}

export async function saveText(env, objectKey, text, metadata = {}) {
  const body = Buffer.from(String(text || ''), 'utf8');
  await getBucket(env).file(objectKey).save(body, {
    resumable: false,
    validation: 'crc32c',
    metadata: {
      contentType: 'text/plain; charset=utf-8',
      cacheControl: 'private, no-store',
      ...metadata
    }
  });
  return body.length;
}

export async function downloadBuffer(env, objectKey) {
  const [buffer] = await getBucket(env).file(objectKey).download();
  return buffer;
}

export async function copyObject(env, sourceKey, destinationKey) {
  await getBucket(env).file(sourceKey).copy(getBucket(env).file(destinationKey));
}

export async function listObjects(env, prefix) {
  const [files] = await getBucket(env).getFiles({ prefix });
  return files;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export function processedTextKey(uid, objectKey) {
  return `users/${uid}/processed/${sha256(objectKey)}.txt`;
}

export function processedMetaKey(uid, objectKey) {
  return `users/${uid}/processed/${sha256(objectKey)}.json.gz`;
}

export async function getProcessedText(env, uid, objectKey) {
  if (!String(objectKey || '').startsWith(`users/${uid}/files/`)) {
    throw new Error('The requested file does not belong to this account.');
  }
  return downloadBuffer(env, processedTextKey(uid, objectKey)).then(b => b.toString('utf8'));
}
