// Holder perks are decided on the server from balanceOf: tier boundaries, locked state without a token, a client-sent
// tier is ignored, limits per tier, failed reads fail closed, and the wording.
import { describe, expect, test } from "bun:test";
import { appRouter, relayBudget, type Ctx } from "../src/api/router";
import { RateLimiter } from "../src/api/rateLimit";
import { holderTier } from "../src/api/perks";
import { makeClients } from "../src/chain";
import { loadEnv } from "../src/config/env";
import { LIMITS, perksFor, tierFromBalance } from "../src/core/perks";
import { copy } from "../src/core/copy";
import type { Deps } from "../src/workers/deps";

const TOKEN = "0x00000000000000000000000000000000000000a1";
const ESCROW = "0x00000000000000000000000000000000000e5c20";
const W = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const E18 = 10n ** 18n;

function harness(env: Record<string, string> = { IFSO_TOKEN_ADDRESS: TOKEN }, balances: Record<string, bigint> = {}) {
  const e = loadEnv({ ESCROW_ADDRESS: ESCROW, ...env });
  const calls: string[] = [];
  const clients = makeClients(e);
  const stub = {
    async readContract(a: { functionName: string; args?: unknown[]; address: string }) {
      calls.push(a.functionName);
      if (a.functionName === "balanceOf") {
        const b = balances[String(a.args?.[0]).toLowerCase()];
        if (b === undefined) throw new Error("rpc down");
        return b;
      }
      if (a.functionName === "feeFor") return 250_000n;
      throw new Error("unexpected " + a.functionName);
    },
  };
  const deps: Deps = { env: e, db: undefined as never, clients: { ...clients, publicClient: stub as never }, log: () => {} };
  const ctx: Ctx = { deps, limiter: new RateLimiter(), ip: "203.0.113.1" };
  return { deps, ctx, calls, caller: appRouter.createCaller(ctx), balances };
}

describe("tier boundaries (100,000 and 1,000,000 $IFSO)", () => {
  const cfg = { holderMin: 100_000, whaleMin: 1_000_000, decimals: 18 };
  test.each([
    [0n, "none"],
    [99_999n * E18, "none"],
    [100_000n * E18 - 1n, "none"],
    [100_000n * E18, "holder"],
    [999_999n * E18, "holder"],
    [1_000_000n * E18 - 1n, "holder"],
    [1_000_000n * E18, "whale"],
    [5_000_000n * E18, "whale"],
  ])("balance %p is %p", (bal, tier) => expect(tierFromBalance(bal as bigint, cfg)).toBe(tier as never));

  test("through the server read: 99,999 / 100,000 / 999,999 / 1,000,000", async () => {
    const h = harness({ IFSO_TOKEN_ADDRESS: TOKEN }, { [W(1)]: 99_999n * E18, [W(2)]: 100_000n * E18, [W(3)]: 999_999n * E18, [W(4)]: 1_000_000n * E18 });
    expect((await h.caller.perks({ address: W(1) })).tier).toBe("none");
    expect((await h.caller.perks({ address: W(2) })).tier).toBe("holder");
    expect((await h.caller.perks({ address: W(3) })).tier).toBe("holder");
    expect((await h.caller.perks({ address: W(4) })).tier).toBe("whale");
  });

  test("thresholds and decimals come from one config", async () => {
    const h = harness({ IFSO_TOKEN_ADDRESS: TOKEN, IFSO_TOKEN_DECIMALS: "6", HOLDER_MIN_IFSO: "10", WHALE_MIN_IFSO: "20" }, { [W(1)]: 10_000_000n, [W(2)]: 20_000_000n });
    expect((await h.caller.perks({ address: W(1) })).tier).toBe("holder");
    expect((await h.caller.perks({ address: W(2) })).tier).toBe("whale");
  });
});

describe("locked state when the token does not exist yet", () => {
  test("perks: everything locked, wording says hold 100,000 $IFSO to unlock, no chain call", async () => {
    const h = harness({});
    const r = await h.caller.perks({ address: W(1) });
    expect(r.tier).toBe("none");
    expect(r.tokenLive).toBe(false);
    expect(r.unlocked).toEqual([]);
    expect(r.locked.map((p) => p.id).sort()).toEqual(["batch", "limits_holder", "limits_whale", "payroll"]);
    expect(r.wording).toContain("hold 100,000 $IFSO to unlock");
    expect(h.calls).toEqual([]);
  });

  test("planBatch and planPayroll return a locked answer with the same wording", async () => {
    const h = harness({});
    const b = await h.caller.planBatch({ sender: W(1), csv: `${W(9)},5` });
    expect(b).toMatchObject({ ok: false, locked: true, tier: "none" });
    expect((b as { wording: string }).wording).toContain("hold 100,000 $IFSO to unlock");
    const p = await h.caller.planPayroll({ sender: W(1), csv: `${W(9)},5`, runs: 2, every: "month" });
    expect(p).toMatchObject({ ok: false, locked: true });
    expect(h.calls).toEqual([]);
  });

  test("a whale-looking balance does nothing while no token address is set", async () => {
    const h = harness({}, { [W(1)]: 10n ** 30n });
    expect((await h.caller.perks({ address: W(1) })).tier).toBe("none");
  });
});

describe("the server ignores whatever tier the client sends", () => {
  test("perks, planBatch and planPayroll: extra tier fields change nothing", async () => {
    const h = harness({ IFSO_TOKEN_ADDRESS: TOKEN }, { [W(1)]: 5n * E18 });
    const r = await (h.caller.perks as (i: unknown) => Promise<{ tier: string }>)({ address: W(1), tier: "whale", holder: true });
    expect(r.tier).toBe("none");
    const b = await (h.caller.planBatch as (i: unknown) => Promise<{ locked?: boolean }>)({ sender: W(1), tier: "whale", csv: `${W(9)},5` });
    expect(b.locked).toBe(true);
    const p = await (h.caller.planPayroll as (i: unknown) => Promise<{ locked?: boolean }>)({ sender: W(1), tier: "whale", csv: `${W(9)},5`, runs: 1, every: "week" });
    expect(p.locked).toBe(true);
  });

  test("a failed balance read fails closed and is not cached", async () => {
    const h = harness({ IFSO_TOKEN_ADDRESS: TOKEN }, {});
    expect(await holderTier(h.deps, W(1) as never)).toBe("none");
    h.balances[W(1)] = 200_000n * E18;
    expect(await holderTier(h.deps, W(1) as never)).toBe("holder");
  });

  test("short cache: one read inside the window, a fresh read after it", async () => {
    const h = harness({ IFSO_TOKEN_ADDRESS: TOKEN, PERKS_CACHE_SECONDS: "30" }, { [W(1)]: 200_000n * E18 });
    const t0 = 1_000_000;
    expect(await holderTier(h.deps, W(1) as never, t0)).toBe("holder");
    h.balances[W(1)] = 0n; // sold
    expect(await holderTier(h.deps, W(1) as never, t0 + 10_000)).toBe("holder");
    expect(await holderTier(h.deps, W(1) as never, t0 + 31_000)).toBe("none");
    expect(h.calls.filter((c) => c === "balanceOf").length).toBe(2);
  });
});

describe("premium endpoints and limits", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `${W(100 + i)},2.5`).join("\n");

  test("Holder: CSV batch planned with totals, header skipped, bad rows reported", async () => {
    const h = harness({ IFSO_TOKEN_ADDRESS: TOKEN }, { [W(1)]: 100_000n * E18 });
    const r = (await h.caller.planBatch({ sender: W(1), csv: `address,amount\n${W(5)},10\nnot-an-address,3\n${W(6)},0.5\n${W(7)},1.25` })) as any;
    expect(r.locked).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p: { line: number }) => p.line)).toEqual([3, 4]);
    expect(r.totals).toMatchObject({ count: 2, amountText: "11.25", feesText: "0.5", totalText: "11.75" });
  });

  test("batch size limit: Holder 50, Whale 200, over the limit is refused with the wording", async () => {
    const h = harness({ IFSO_TOKEN_ADDRESS: TOKEN }, { [W(1)]: 100_000n * E18, [W(2)]: 1_000_000n * E18 });
    expect(LIMITS.holder.batchSize).toBe(50);
    expect(LIMITS.whale.batchSize).toBe(200);
    expect(((await h.caller.planBatch({ sender: W(1), csv: rows(50) })) as any).ok).toBe(true);
    const over = (await h.caller.planBatch({ sender: W(1), csv: rows(51) })) as any;
    expect(over).toMatchObject({ ok: false, locked: false, limit: 50 });
    expect(over.reason).toContain("up to 50 payments");
    expect(((await h.caller.planBatch({ sender: W(2), csv: rows(200) })) as any).ok).toBe(true);
    expect(((await h.caller.planBatch({ sender: W(2), csv: rows(201) })) as any).limit).toBe(200);
  });

  test("scheduled payments limit counts rows x runs", async () => {
    const h = harness({ IFSO_TOKEN_ADDRESS: TOKEN }, { [W(1)]: 100_000n * E18 });
    const ok = (await h.caller.planPayroll({ sender: W(1), csv: rows(5), runs: 5, every: "month" })) as any;
    expect(ok).toMatchObject({ ok: true, scheduled: 25 });
    const over = (await h.caller.planPayroll({ sender: W(1), csv: rows(5), runs: 6, every: "month" })) as any;
    expect(over).toMatchObject({ ok: false, limit: 25 });
  });

  test("relay budget: a Holder gets double the per-wallet hourly budget, a non-holder the base", async () => {
    const h = harness({ IFSO_TOKEN_ADDRESS: TOKEN, RELAY_PER_SIGNER_PER_HOUR: "2", RELAY_PER_IP_PER_HOUR: "1000" }, { [W(1)]: 100_000n * E18, [W(2)]: 1n });
    const hit = (who: string) => (h.ctx.limiter as RateLimiter).hit(`relay:signer:${who}`, 1, 1); // sanity: limiter works
    expect(await hit("x")).toBe(true);
    for (let i = 0; i < 4; i++) await relayBudget(h.ctx, W(1) as never); // 4 = 2 x 2
    await expect(relayBudget(h.ctx, W(1) as never)).rejects.toThrow("too many requests");
    for (let i = 0; i < 2; i++) await relayBudget(h.ctx, W(2) as never);
    await expect(relayBudget(h.ctx, W(2) as never)).rejects.toThrow("too many requests");
  });
});

describe("wording", () => {
  const cfg = { tokenConfigured: true, holderMin: 100_000, whaleMin: 1_000_000, decimals: 18 };
  test("below Holder, Holder and Whale each say what to hold, never buy or price talk", () => {
    expect(perksFor("none", cfg).wording).toBe("Premium features: hold 100,000 $IFSO to unlock.");
    expect(perksFor("holder", cfg).wording).toBe("Higher limits: hold 1,000,000 $IFSO to unlock.");
    expect(perksFor("whale", cfg).wording).toBe("");
    for (const t of ["none", "holder", "whale"] as const) {
      const s = perksFor(t, cfg);
      const text = JSON.stringify(s);
      expect(text).not.toMatch(/\b(buy|bought|price|invest\w*|return\w*|earn\w*|profit)\b/i);
    }
  });
  test("copy.perks passes the banned-words list", () => {
    const all = [copy.perks.lockedHolder("1"), copy.perks.lockedWhale("1"), copy.perks.tokenNotLive("1"), copy.perks.batchPerk, copy.perks.payrollPerk, copy.perks.limitsHolder, copy.perks.limitsWhale, copy.perks.batchTooBig("1"), copy.perks.scheduleTooBig("1"), copy.perks.noCash].join(" ");
    expect(all).not.toMatch(/\b(apy|yield\w*|guarantee\w*|stake[sd]?|payouts?|safe\w*|odds|bet)\b/i);
    expect(all).not.toMatch(/\bbuy\b/i);
  });
});
