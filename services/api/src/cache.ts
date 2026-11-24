import { Redis } from "ioredis";
import type { Cache } from "./types.js";

export class RedisCache implements Cache {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, "EX", ttlSeconds);
  }

  async delByPrefix(prefix: string): Promise<void> {
    // SCAN rather than KEYS so we never block Redis on a large keyspace.
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
      if (keys.length) await this.redis.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

/** Used in tests and when running the API without Redis. */
export class MemoryCache implements Cache {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async delByPrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) if (key.startsWith(prefix)) this.store.delete(key);
  }

  async ping(): Promise<void> {}
}
