import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
export const redis = new Redis(redisUrl);

// Rate limiter helper function (Token Bucket).
// `bucket` namespaces the Redis key so independent limits (e.g. the blanket
// per-IP limit vs. a tighter one just for /v1/auth/login) don't share a
// counter and clobber each other.
export async function checkRateLimit(
  ip: string,
  limit: number,
  windowSeconds: number,
  bucket: string = 'global'
): Promise<boolean> {
  const key = `ratelimit:${bucket}:${ip}`;
  const current = await redis.incr(key);

  if (current === 1) {
    await redis.expire(key, windowSeconds);
  }

  return current <= limit;
}
