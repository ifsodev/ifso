// Review round 3 fixes in the services (besides R3-H1 and R3-M1, which have their own files):
//  - R3-L2 never-sendable rows on a token with a pending multiplier change get a (short) back-off and a per-pass cap
//  - R3-L1 /stats computed once a minute; one per-network read budget on stats, perks, planBatch, planPayroll
//  - DECISIONS #33 Polymarket earliestResolve = endDate + 24 h
import { beforeEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter } from "../src/api/router";
import { userStats } from "../src/api/stats";
import { createApp } from "../src/api/app";
import { loadEnv } from "../src/config/env";
import { DEFAULTS } from "../src/core/builder";
import { Status } from "../src/core/types";
import { escrows } from "../src/db/schema";
import { keeperTick, resetKeeperBackoff, URGENT_PER_PASS } from "../src/workers/keeper";
import { assertLastCall, planPolymarketQuestion, questionIdFor } from "../src/workers/resolver";
import type { Deps } from "../src/workers/deps";
import { bootDb, havePostgres } from "./helpers/chain";

const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const CH = ("0x" + "42".repeat(32)) as Hex;

// ------------------------------------------------------------------------------------------------------------------
// R3-L2: 210 AT_DEADLINE rows on a Stock Token with an announced multiplier change, none of which can ever be sent (no
// round in force at their deadline), sit at the head of the deadline-ordered page. On c5bf754 they were exempt from the
// wait back-off, so they filled the 200-row scan on every pass until effectiveAt and the honest row behind them on
// another feed was never settled.
// ------------------------------------------------------------------------------------------------------------------
describe("R3-L2: never-sendable rows before a multiplier change do not hide other rows", () => {
  beforeEach(resetKeeperBackoff);

  test.skipIf(!havePostgres())("210 never-sendable urgent rows + 1 honest AT_DEADLINE row on another feed: the honest row settles within two passes", async () => {
    const pg = await bootDb();
    try {
      const now = Math.floor(Date.now() / 1000);
      const FEED = "0x000000000000000000000000000000000000f00d" as Address;
      const TOKEN = "0x000000000000000000000000000000000000a5a5" as Address;
      const cond = (deadline: number, stockToken: string) => ({ kind: 1, mode: 0, op: 0, source: 0, target: FEED, stockToken, key: "0x" + "00".repeat(32), threshold: "20000000000", multiplier: stockToken === ZERO ? "0" : "1000000000000000000", outcomeMask: "0", start: "0", deadline: String(deadline), maxStale: 3600, holdWindow: 3 * 86400 });
      const row = (id: string, deadline: number, stockToken: string, expiry: number) => ({ id, kind: 2, status: Status.OPEN, twoSided: false, accepted: false, deadline: new Date(deadline * 1000), expiry: new Date(expiry * 1000), activeFrom: new Date((deadline - 86400) * 1000), condition: cond(deadline, stockToken), sender: ZERO, amount: "1000000", conditionHash: CH, feed: FEED, createdBlock: 1n, createdTx: "0x" });
      const rows = [...Array.from({ length: 210 }, (_, i) => row(String(1000 + i), now - 10 * 86400 + i, TOKEN, now + 300 * 86400)), row("7", now - 3600, ZERO, now + 3 * 86400)];
      for (let i = 0; i < rows.length; i += 100) await pg.db.insert(escrows).values(rows.slice(i, i + 100));
      const R = (n: bigint) => (1n << 64n) | n;
      const rounds: Record<string, { answer: bigint; updatedAt: bigint }> = { [R(1n).toString()]: { answer: 21_000_000_000n, updatedAt: BigInt(now - 3700) }, [R(2n).toString()]: { answer: 21_000_000_000n, updatedAt: BigInt(now - 1800) } };
      const sent: Array<{ functionName: string; args: unknown[] }> = [];
      let multiplierReads = 0;
      const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" as Address }, writeContract: async (req: { functionName: string; args: unknown[] }) => (sent.push(req), "0xabc" as Hex) };
      const deps = {
        env: loadEnv({ ESCROW_ADDRESS: ESCROW }),
        log: () => {},
        alert: async () => true,
        db: pg.db,
        clients: {
          chain: { id: 4663 },
          escrow: ESCROW,
          keeper: wallet,
          publicClient: {
            getBlock: async () => ({ timestamp: BigInt(now) }),
            readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
              if (functionName === "effectiveAt") return BigInt(now + 3 * 86400); // a split announced for in 3 days
              if (functionName === "uiMultiplier") return (multiplierReads++, 10n ** 18n);
              if (functionName === "latestRoundData") return [R(2n), rounds[R(2n).toString()]!.answer, 0n, rounds[R(2n).toString()]!.updatedAt, R(2n)];
              if (functionName === "getRoundData") {
                const r = rounds[String(args![0])];
                if (!r) throw new Error("no round");
                return [args![0], r.answer, 0n, r.updatedAt, args![0]];
              }
              throw new Error("unexpected read " + functionName);
            },
            simulateContract: async (req: unknown) => ({ request: req }),
            estimateContractGas: async () => 100_000n,
            getGasPrice: async () => 1_000_000n,
            waitForTransactionReceipt: async () => ({ status: "success" }),
          },
        },
      } as unknown as Deps;
      await keeperTick(deps);
      expect(multiplierReads).toBeLessThanOrEqual(URGENT_PER_PASS); // urgent rows looked at per pass are capped
      const first = multiplierReads;
      await keeperTick(deps);
      expect(multiplierReads - first).toBeLessThanOrEqual(URGENT_PER_PASS); // rows in back-off are not re-planned
      expect(sent.some((s) => s.functionName === "settle" && s.args[0] === 7n)).toBe(true);
      expect(sent.filter((s) => s.functionName === "settle").length).toBe(1);
    } finally {
      await pg.stop();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------
// R3-L1: unauthenticated reads
// ------------------------------------------------------------------------------------------------------------------
describe("R3-L1: stats cache and the per-network read budget", () => {
  function deps(env: Record<string, string> = {}) {
    let scans = 0;
    let rpc = 0;
    const q: any = { from: () => q, where: async () => (scans++, []) };
    const d = {
      env: loadEnv({ ESCROW_ADDRESS: ESCROW, IFSO_TOKEN_ADDRESS: "0x000000000000000000000000000000000000beef", ...env }),
      log: () => {},
      db: { select: () => q },
      clients: { chain: { id: 4663 }, escrow: ESCROW, publicClient: { readContract: async () => (rpc++, 0n) } },
    } as unknown as Deps;
    return { d, scans: () => scans, rpc: () => rpc };
  }

  test("/stats is computed once per minute for every caller", async () => {
    const { d, scans } = deps();
    const t = Date.now();
    for (let i = 0; i < 50; i++) await userStats(d, undefined, t + i);
    expect(scans()).toBe(1);
    await userStats(d, undefined, t + 61_000);
    expect(scans()).toBe(2);
  });

  test("perks, stats, planBatch and planPayroll share one budget per client network; another network is unaffected", async () => {
    const { d, rpc } = deps({ READS_PER_IP_PER_HOUR: "5" });
    const l = new RateLimiter();
    const c = (ip: string) => appRouter.createCaller({ deps: d, limiter: l, ip, country: "DE" });
    const rand = (i: number) => ("0x" + i.toString(16).padStart(40, "0")) as Address;
    await c("198.51.100.1").perks({ address: rand(1) });
    await c("198.51.100.1").perks({ address: rand(2) });
    await c("198.51.100.1").stats();
    await c("198.51.100.1").planBatch({ sender: rand(3), items: [] });
    await c("198.51.100.1").planPayroll({ sender: rand(4), items: [], runs: 1, every: "week" });
    const before = rpc();
    await expect(c("198.51.100.1").perks({ address: rand(5) })).rejects.toThrow("too many requests");
    await expect(c("198.51.100.1").planBatch({ sender: rand(6), items: [] })).rejects.toThrow("too many requests");
    expect(rpc()).toBe(before); // refused before any RPC read
    await c("203.0.113.5").perks({ address: rand(7) });
  });

  test("the REST /stats/users route is under the same budget", async () => {
    const { d } = deps({ READS_PER_IP_PER_HOUR: "2" });
    const app = createApp(d, new RateLimiter());
    const get = () => app.request("/stats/users", {}, { socketIp: "198.51.100.9" });
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(429);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// DECISIONS #33: a Polymarket question resolves no earlier than endDate + 24 h (after the expected UMA settlement)
// ------------------------------------------------------------------------------------------------------------------
describe("DECISIONS #33: Polymarket earliestResolve", () => {
  test("planned questions carry earliestResolve = endDate + 24 h, and the id commits to it", async () => {
    const end = Math.floor(Date.now() / 1000) + 10 * 86400;
    const market = { question: "Will it happen?", conditionId: "0x" + "cd".repeat(32), endDate: new Date(end * 1000).toISOString(), closed: false, active: true, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', liquidityNum: 1e6, volumeNum: 1e6 };
    const inserted: Array<Record<string, unknown>> = [];
    const sel: any = { from: () => sel, where: async () => [] };
    const d = {
      env: loadEnv({}),
      log: () => {},
      sources: { gamma: async () => ({ market, report: undefined }) },
      db: { select: () => sel, insert: () => ({ values: (v: Record<string, unknown>) => (inserted.push(v), { onConflictDoNothing: () => ({ returning: async () => [{ id: v.id }] }) }) }) },
    } as unknown as Deps;
    const q = await planPolymarketQuestion(d, "will-it-happen");
    expect(DEFAULTS.polymarketResolveDelay).toBe(24 * 3600);
    expect(q.closeTime).toBe(end);
    expect(q.earliestResolve).toBe(end + 24 * 3600);
    expect((inserted[0]!.earliestResolve as Date).getTime()).toBe((end + 24 * 3600) * 1000);
    expect(q.id).toBe(questionIdFor(inserted[0]!.specHash as Hex, end, end + 24 * 3600, 2));
  });
});

describe("R3-H1: last-call slot configuration", () => {
  test("the resolver refuses a slot of half the dispute window or more, or fewer than 4 ticks", () => {
    expect(assertLastCall(loadEnv({}).RESOLVER_LAST_CALL_SECONDS, 7200)).toBe(1200);
    expect(() => assertLastCall(3600, 7200)).toThrow("half");
    expect(() => assertLastCall(120, 7200)).toThrow("4 resolver ticks");
  });
});
