import { TooManyRequestsError } from './errors.js';

export function createRateLimiter({ max, windowMs }) {
  const buckets = new Map();

  return function checkRateLimit(key, now = Date.now()) {
    const current = buckets.get(key);

    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }

    current.count += 1;

    if (current.count > max) {
      throw new TooManyRequestsError();
    }

    if (buckets.size > 10_000) {
      for (const [bucketKey, bucket] of buckets.entries()) {
        if (bucket.resetAt <= now) {
          buckets.delete(bucketKey);
        }
      }
    }
  };
}
