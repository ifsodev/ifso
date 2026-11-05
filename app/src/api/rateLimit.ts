import type IORedis from "ioredis";
import { keccak256, toHex } from "viem";

/** INCR, and set the window's expiry when the key is new or (after a crash) has none. Atomic in Redis. */
export const HIT_SCRIPT = `local n = redis.call('INCR', KEYS[1])
if n == 1 or redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

/** Per-IP fixed-window limiter. IPs are hashed with a secret salt (IP_HASH_SALT) and the date and never stored raw. */
export class RateLimiter {
  private mem = new Map<string, { n: number; until: number }>();
  constructor(private redis?: IORedis) {}

  static ipHash(ip: string, salt = ""): string {
    const day = new Date().toISOString().slice(0, 10);
    return keccak256(toHex(`ifso:${salt}:${day}:${ip}`)).slice(0, 18);
  }

  async hit(key: string, limit: number, windowSec: number): Promise<boolean> {
    if (this.redis) {
      // audit I-17: increment and expiry in one atomic script, so a crash between them never leaves a key without a TTL
      const n = Number(await this.redis.eval(HIT_SCRIPT, 1, `rl:${key}`, windowSec));
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
