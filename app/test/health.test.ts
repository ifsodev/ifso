import { describe, expect, test } from "bun:test";
import { createApp } from "../src/api/app";
import { RateLimiter } from "../src/api/rateLimit";
import { loadEnv } from "../src/config/env";
import { defaultProbes, guard, readiness } from "../src/ops/health";
import type { Deps } from "../src/workers/deps";

const mkDeps = (over: Record<string, unknown> = {}) =>
  ({
    env: loadEnv({}),
    log: () => {},
    db: { execute: async () => [] },
    clients: { chain: { id: 4663 }, escrow: undefined, usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", publicClient: { getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000) - 2) }) }, ...over },
  }) as unknown as Deps;

describe("health (R7)", () => {
  test("healthz is up regardless of dependencies", async () => {
    const app = createApp(mkDeps(), new RateLimiter(), undefined, { db: async () => "db down" });
    expect((await app.request("/healthz")).status).toBe(200);
  });
  test("readyz 200 when every probe is healthy", async () => {
    const app = createApp(mkDeps(), new RateLimiter(), undefined, defaultProbes(mkDeps()));
    const r = await app.request("/readyz");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, reasons: [] });
  });
  test("readyz 503 with a reason when the database is down", async () => {
    const deps = mkDeps();
    (deps.db as unknown as { execute: () => Promise<never> }).execute = async () => { throw new Error("connection refused"); };
    const r = await createApp(deps, new RateLimiter(), undefined, defaultProbes(deps)).request("/readyz");
    expect(r.status).toBe(503);
    expect(((await r.json()) as { reasons: string[] }).reasons[0]).toContain("db down");
  });
  test("503 when redis is down, when RPC head lags over 60 s, and when a hot key is low", async () => {
    const redis = { ping: async () => { throw new Error("ECONNREFUSED"); } } as never;
    expect((await readiness(defaultProbes(mkDeps(), redis))).reasons.join()).toContain("redis down");
    const stale = mkDeps({ publicClient: { getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000) - 120) }) } });
    expect((await readiness(defaultProbes(stale))).reasons.join()).toContain("rpc head lag");
    const poor = mkDeps({ relayer: { account: { address: "0x00000000000000000000000000000000000000ee" } }, publicClient: { getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }), getBalance: async () => 0n } });
    expect((await readiness(defaultProbes(poor))).reasons.join()).toContain("relayer ETH low");
  });
  test("audit I-9: 503 when the relayer is not the resolver's question creator, 200 when it is", async () => {
    const relayer = "0x00000000000000000000000000000000000000ee";
    const resolverContract = "0x00000000000000000000000000000000000000aa";
    const asked: unknown[] = [];
    const withCreator = (isCreator: boolean) =>
      mkDeps({
        relayer: { account: { address: relayer } },
        resolverContract,
        publicClient: {
          getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
          getBalance: async () => 10n ** 18n,
          readContract: async (a: { functionName: string; args: unknown[]; address: string }) => (asked.push([a.address, a.functionName, ...a.args]), isCreator),
        },
      });
    const bad = await createApp(withCreator(false), new RateLimiter(), undefined, defaultProbes(withCreator(false))).request("/readyz");
    expect(bad.status).toBe(503);
    expect(((await bad.json()) as { reasons: string[] }).reasons.join()).toContain(`relayer ${relayer} is not a question creator`);
    expect(asked).toContainEqual([resolverContract, "isCreator", relayer]);
    const good = await createApp(withCreator(true), new RateLimiter(), undefined, defaultProbes(withCreator(true))).request("/readyz");
    expect(good.status).toBe(200);
  });
  test("a throwing probe becomes a reason, not a crash", async () => {
    expect((await readiness({ x: guard("x broke", async () => { throw new Error("no"); }) })).ok).toBe(false);
  });
});
