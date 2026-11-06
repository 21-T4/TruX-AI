/* In-memory token-bucket rate limiter per instance. Cloud Run may run several
   instances, so this is a guard against abuse, not exact accounting. */
const buckets = new Map();

export function rateLimit(key, { capacity = 30, refillPerSecond = 0.5 } = {}) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, updatedAt: now };
    buckets.set(key, bucket);
  }
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.updatedAt) / 1000) * refillPerSecond);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, bucket] of buckets) if (bucket.updatedAt < cutoff) buckets.delete(key);
}, 60 * 1000).unref();
