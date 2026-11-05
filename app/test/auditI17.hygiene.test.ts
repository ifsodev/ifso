// Audit I-17 regressions (small hygiene): no raw error text to callers, a constant-time webhook token check, an atomic
// rate-limit increment and expiry, and RPC failover text without keys in the URL path or query. The /mine group rule is
// in botStore.pg.test.ts.
import { describe, expect, test } from "bun:test";
import { custom } from "viem";
import { createApp } from "../src/api/app";
import { HIT_SCRIPT, RateLimiter } from "../src/api/rateLimit";
import { INTERNAL_MESSAGE } from "../src/api/router";
import { makeClients } from "../src/chain";
import { makePublicClient, redactRpcText, redactRpcUrl } from "../src/chain/rpc";
import { loadEnv } from "../src/config/env";
import { webhookTokenOk } from "../src/bot/webhook";
import type { Deps } from "../src/workers/deps";

describe("I-17: no raw error text reaches a caller", () => {
  const env = loadEnv({ ESCROW_ADDRESS: "0x00000000000000000000000000000000000e5c20" });
  const logged: unknown[] = [];
  const secret = "connect ECONNREFUSED db.internal.example:5432 user=ifso";
  const db = new Proxy({}, { get: () => () => { throw new Error(secret); } });
  const deps = { env, db, clients: makeClients(env), log: (...a: unknown[]) => logged.push(a) } as unknown as Deps;
  const app = createApp(deps, new RateLimiter());

  test("an unexpected error is INTERNAL_SERVER_ERROR with a fixed message; the raw text goes to the log only", async () => {
    const r = await app.request(`/trpc/mine?input=${encodeURIComponent(JSON.stringify({ address: "0x00000000000000000000000000000000000000aa" }))}`);
    const text = await r.text();
    expect(r.status).toBe(500);
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("db.internal");
    expect(JSON.parse(text).error.message).toBe(INTERNAL_MESSAGE);
    expect(JSON.parse(text).error.data.code).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(logged)).toContain("ECONNREFUSED");
  });
});

describe("I-17: webhook secret token", () => {
  test("constant-time compare: only the exact token passes", () => {
    expect(webhookTokenOk("s3cret-token", "s3cret-token")).toBe(true);
    for (const bad of ["s3cret-toke", "s3cret-token ", "S3cret-token", "", "x".repeat(300)]) expect(webhookTokenOk(bad, "s3cret-token")).toBe(false);
    expect(webhookTokenOk(null, "s3cret-token")).toBe(false);
    expect(webhookTokenOk("anything", undefined)).toBe(false);
  });
});

describe("I-17: rate limit increment and expiry are one atomic Redis call", () => {
  test("hit runs one EVAL of the INCR+EXPIRE script and never a separate INCR or EXPIRE", async () => {
    const calls: unknown[][] = [];
    const counts = new Map<string, number>();
    const redis = {
      eval: async (...a: unknown[]) => {
        calls.push(a);
        const k = a[2] as string;
        counts.set(k, (counts.get(k) ?? 0) + 1);
        return counts.get(k)!;
      },
      incr: () => { throw new Error("non-atomic incr"); },
      expire: () => { throw new Error("non-atomic expire"); },
    };
    const rl = new RateLimiter(redis as never);
    expect(await rl.hit("k", 2, 60)).toBe(true);
    expect(await rl.hit("k", 2, 60)).toBe(true);
    expect(await rl.hit("k", 2, 60)).toBe(false);
    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual([HIT_SCRIPT, 1, "rl:k", 60]);
    expect(HIT_SCRIPT).toContain("INCR");
    expect(HIT_SCRIPT).toContain("EXPIRE");
    expect(HIT_SCRIPT).toContain("TTL"); // a key left without a TTL gets one on the next hit
  });
});

describe("I-17: RPC failover text redaction", () => {
  test("userinfo, path keys and query keys are dropped", () => {
    expect(redactRpcUrl("https://user:pw@rpc.example.com/v3/KEY123?apikey=SECRET9")).toBe("https://rpc.example.com/...");
    expect(redactRpcUrl("https://rpc.example.com/?apikey=SECRET9")).toBe("https://rpc.example.com/...");
    expect(redactRpcUrl("https://rpc.example.com")).toBe("https://rpc.example.com");
    expect(redactRpcText('HTTP request failed. URL: https://rpc.example.com/v2/KEY123?k=SECRET9 Details: 429')).toBe("HTTP request failed. URL: https://rpc.example.com/... Details: 429");
  });

  test("the failover alert names the host only, in `from` and in the error text", async () => {
    const seen: { from: string; error: string }[] = [];
    const a = "https://rpc.example.com/v3/KEY123?apikey=SECRET9";
    const client = makePublicClient([a, "https://b.test"], {
      onFailover: (i) => seen.push(i),
      transportFor: (url) =>
        custom({
          async request({ method }) {
            if (url === a) throw new Error(`HTTP request failed. URL: ${a}`);
            return method === "eth_blockNumber" ? "0x10" : "0x1";
          },
        }),
    });
    expect(await client.getBlockNumber()).toBe(16n);
    expect(seen.length).toBe(1);
    expect(JSON.stringify(seen)).not.toMatch(/KEY123|SECRET9/);
    expect(seen[0]!.from).toBe("https://rpc.example.com/...");
  });
});
