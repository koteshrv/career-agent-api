import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
export const redis = new Redis(redisUrl);

// Rate limiter helper function (Token Bucket)
export async function checkRateLimit(ip: string, limit: number, windowSeconds: number): Promise<boolean> {
  const key = `ratelimit:${ip}`;
  const current = await redis.incr(key);
  
  if (current === 1) {
    await redis.expire(key, windowSeconds);
  }
  
  return current <= limit;
}
