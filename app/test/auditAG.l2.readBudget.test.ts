// Audit L-2 regression (R3-L1 residual): build, escrow, mine, question, /q/:file and /readyz had no read budget, and
// /stats/users ran a fresh full scan for every distinct `since` value, so one client could spend the shared free RPC
// quota and database time. Each assertion below FAILED on 6d90e71 (every call went through; one scan per `since`).
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/api/app";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter } from "../src/api/router";
import { userStats } from "../src/api/stats";
import { loadEnv } from "../src/config/env";
import type { Deps } from "../src/workers/deps";

const BUDGET = 3;
function stub() {
  const counts = { rpc: 0, db: 0, probes: 0 };
  const q: any = { from: () => q, where: () => q, orderBy: () => q, limit: () => q, then: (res: (v: unknown[]) => unknown) => (counts.db++, res([])) };
  const deps = {
    env: loadEnv({ ESCROW_ADDRESS: "0x00000000000000000000000000000000000e5c20", READS_PER_IP_PER_HOUR: String(BUDGET) }),
    log: () => {},
    db: { select: () => q },
    clients: {
      chain: { id: 4663 }, escrow: "0x00000000000000000000000000000000000e5c20", usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      publicClient: { readContract: async () => (counts.rpc++, { status: 0 }) },
    },
  } as unknown as Deps;
  return { deps, counts };
}
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? "error");

describe("audit L-2: every unauthenticated DB/RPC read is budgeted per network", () => {
  test("tRPC build, escrow, mine and question refuse once the network's read budget is used", async () => {
    for (const call of [
      (c: ReturnType<typeof appRouter.createCaller>) => c.build({ text: "/ifso 0x00000000000000000000000000000000000b0b0b 10 on 2031-01-01", sender: "0x00000000000000000000000000000000000000aa" }),
      (c: ReturnType<typeof appRouter.createCaller>) => c.escrow({ id: "1" }),
      (c: ReturnType<typeof appRouter.createCaller>) => c.mine({ address: "0x00000000000000000000000000000000000000aa" }),
      (c: ReturnType<typeof appRouter.createCaller>) => c.question({ specHash: "0x01" }),
    ]) {
      const { deps } = stub();
      const caller = appRouter.createCaller({ deps, limiter: new RateLimiter(), ip: "198.51.100.20", country: "DE" });
      for (let i = 0; i < BUDGET; i++) expect(await codeOf(call(caller))).not.toBe("TOO_MANY_REQUESTS");
      expect(await codeOf(call(caller))).toBe("TOO_MANY_REQUESTS");
    }
  });

  test("/q/:file and /readyz are budgeted; readyz runs its probes once per TTL and hides raw error text", async () => {
    const { deps, counts } = stub();
    const app = createApp(deps, new RateLimiter(), undefined, { db: async () => (counts.probes++, "db down: connect ECONNREFUSED 10.0.0.5:5432") });
    for (let i = 0; i < BUDGET; i++) expect((await app.request("/q/abc.json")).status).toBe(404);
    expect((await app.request("/q/abc.json")).status).toBe(429);
    const app2 = createApp(stub().deps, new RateLimiter(), undefined, { db: async () => (counts.probes++, "db down: connect ECONNREFUSED 10.0.0.5:5432") });
    const first = await app2.request("/readyz");
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ ok: false, reasons: ["db down"] });
    await app2.request("/readyz");
    await app2.request("/readyz");
    expect(counts.probes).toBe(1);
    expect((await app2.request("/readyz")).status).toBe(429);
  });

  test("/stats/users: many distinct `since` values cost one scan", async () => {
    const { deps, counts } = stub();
    for (let d = 1; d <= 20; d++) await userStats(deps, Date.parse(`2026-10-${String(d).padStart(2, "0")}T00:00:00Z`) / 1000);
    await userStats(deps, 4_000_000_000); // far future: clamped to today
    expect(counts.db).toBe(1);
  });
});
