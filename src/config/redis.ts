import { Redis } from "ioredis";

async function connectRedis() {
  try {
    const redis = new Redis(process.env.REDIS_URI || '', {
      // port: parseInt(process.env.REDIS_PORT) || 6379, // Redis port
      // host: process.env.REDIS_HOST || '', // Redis host
      // username: "default", // needs Redis >= 6
      // password: process.env.REDIS_PASSWORD || '',
      // db: 0, // Defaults to 0
      retryStrategy: (times: number) => Math.min(times * 50, 2000), // Retry with backoff
      maxRetriesPerRequest: 5, // Limit retries
    });

    const health = await redis.ping();
    if (health === 'PONG') {
      console.log(`[Redis] Connected to redis`);
      return redis;
    }
    throw new Error('Failed to connect to redis');
  } catch (error) {
    console.error("[Redis] Error connecting to Redis:", error);
    process.exit();
  }
}

export default connectRedis;
