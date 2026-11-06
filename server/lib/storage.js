/* Cloud Storage for uploads, processed file text and generated media.
   Every object lives under users/{uid}/ so ownership checks are a prefix test. */
import crypto from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { getBucketName } from './config.js';
import { HttpError } from './http.js';

let storage = null;
export function getStorage() {
  if (!storage) storage = new Storage();
  return storage;
}

export async function getBucket() {
  return getStorage().bucket(await getBucketName());
}

export function safeFileName(name) {
  return String(name || 'upload.bin')
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'upload.bin';
}

function datePath() {
  const now = new Date();
  return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')}`;
}

export function userFileKey(uid, fileName) {
  return `users/${uid}/files/${datePath()}/${crypto.randomUUID()}-${safeFileName(fileName)}`;
}

export function userMediaKey(uid, extension) {
  return `users/${uid}/media/${datePath()}/${crypto.randomUUID()}.${String(extension || 'bin').replace(/[^a-z0-9]/gi, '')}`;
}

export function userVideoPrefix(uid) {
  return `users/${uid}/videos/${datePath()}/${crypto.randomUUID()}`;
}

export function assertOwnedKey(uid, objectKey, kinds = ['files', 'media', 'videos']) {
  const key = String(objectKey || '');
  if (key.includes('..') || !kinds.some(kind => key.startsWith(`users/${uid}/${kind}/`))) {
    throw new HttpError(403, 'That file does not belong to this account.');
  }
  return key;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}
export function processedTextKey(uid, objectKey) { return `users/${uid}/processed/${sha256(objectKey)}.txt`; }
export function processedMetaKey(uid, objectKey) { return `users/${uid}/processed/${sha256(objectKey)}.json`; }

export async function saveBuffer(objectKey, buffer, contentType, metadata = {}) {
  const bucket = await getBucket();
  await bucket.file(objectKey).save(buffer, {
    resumable: false,
    validation: 'crc32c',
    metadata: { contentType, cacheControl: 'private, max-age=31536000, immutable', metadata }
  });
  return objectKey;
}

export async function downloadBuffer(objectKey) {
  const [buffer] = await (await getBucket()).file(objectKey).download();
  return buffer;
}

export async function getProcessedText(uid, objectKey) {
  assertOwnedKey(uid, objectKey, ['files']);
  return (await downloadBuffer(processedTextKey(uid, objectKey))).toString('utf8');
}

