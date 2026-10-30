import type IORedis from "ioredis";
import { keccak256, toHex } from "viem";

/** Per-IP fixed-window limiter. IPs are hashed with a daily salt and never stored raw. */
export class RateLimiter {
  private mem = new Map<string, { n: number; until: number }>();
  constructor(private redis?: IORedis) {}

  static ipHash(ip: string): string {
    const day = new Date().toISOString().slice(0, 10);
    return keccak256(toHex(`ifso:${day}:${ip}`)).slice(0, 18);
  }

  async hit(key: string, limit: number, windowSec: number): Promise<boolean> {
    if (this.redis) {
      const k = `rl:${key}`;
      const n = await this.redis.incr(k);
      if (n === 1) await this.redis.expire(k, windowSec);
      return n <= limit;
    }
    const now = Date.now();
    const e = this.mem.get(key);
    if (!e || e.until < now) {
      this.mem.set(key, { n: 1, until: now + windowSec * 1000 });
      return true;
    }
    e.n += 1;
    return e.n <= limit;
  }
}
