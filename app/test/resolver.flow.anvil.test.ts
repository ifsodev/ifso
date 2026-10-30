// Lazy registration, the public spec route, and the full happy path for both question kinds on anvil:
// register -> (after earliestResolve) propose on two agreeing sources -> finalize after the window -> bond back.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { RateLimiter } from "../src/api/rateLimit";
import { createApp } from "../src/api/app";
import { questionSpecHash } from "../src/core/outcome";
import { questions, relayTxs, sourceReports } from "../src/db/schema";
import { ensureFootballQuestion, ensurePolymarketQuestion, footballSpec, resolverTick } from "../src/workers/resolver";
import { indexerTick } from "../src/workers/indexer";
import { haveAnvil, havePostgres } from "./helpers/chain";
import { bootResolverEnv, createOutcomeEscrow, onchainState, questionOnchain, rowOf, type ResolverEnv } from "./helpers/resolverHarness";
import { eplEvents, expectedFootball, pmMarkets } from "./helpers/resolverFixtures";

setDefaultTimeout(120_000);

describe.skipIf(!haveAnvil() || !havePostgres())("resolver flow on anvil", () => {
  let env: ResolverEnv;
  beforeAll(async () => {
    env = await bootResolverEnv();
  });
  afterAll(async () => env?.stop());

  test("registration is lazy and idempotent; the spec is served at /q/<specHash>.json and hashes to what is on-chain", async () => {
    const a = await env.question(5);
    const again = await ensureFootballQuestion(env.deps, a.fixture);
    expect(again.id).toBe(a.id);
    expect((await env.pg.db.select().from(relayTxs).where(eq(relayTxs.kind, "question-create"))).length).toBe(1);

    const row = await rowOf(env, a.id);
    const res = await createApp(env.deps, new RateLimiter()).request(`/q/${row.specHash}.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as Record<string, unknown>;
    expect(questionSpecHash(spec)).toBe(row.specHash as `0x${string}`);
    expect(spec).toEqual(footballSpec(a.fixture) as never);
    expect((await questionOnchain(env, a.id)).specHash).toBe(row.specHash as `0x${string}`);
    expect((await createApp(env.deps, new RateLimiter()).request(`/q/0x${"00".repeat(32)}.json`)).status).toBe(404);
  });

  test("football: both sources agree -> proposed once -> finalized after the window -> bond withdrawn; evidence rows keep digests only", async () => {
    const q = await env.question(6);
    await env.chain.warpTo(BigInt(q.earliestResolve + 1));
    const start = await env.chain.balance(env.resolverAddress);
    await resolverTick(env.deps);
    await resolverTick(env.deps); // a second tick must not propose again
    const c = await questionOnchain(env, q.id);
    expect([Number(c.state), Number(c.proposed)]).toEqual([2, expectedFootball(eplEvents[6]!)]);
    // two bonds out: this fixture, and the one registered in the first test (also decidable by now)
    expect(await env.chain.balance(env.resolverAddress)).toBe(start - 20_000_000n);
    expect((await env.pg.db.select().from(relayTxs).where(eq(relayTxs.questionId, q.id))).filter((r) => r.kind === "propose").length).toBe(1);

    await env.chain.warpTo(BigInt(Number(c.proposedAt) + 7201));
    await resolverTick(env.deps);
    expect(await onchainState(env, q.id)).toEqual([4, expectedFootball(eplEvents[6]!)]);
    expect(await env.chain.balance(env.resolverAddress)).toBe(start);

    const reports = await env.pg.db.select().from(sourceReports).where(eq(sourceReports.questionId, q.id));
    expect(new Set(reports.map((r) => r.provider))).toEqual(new Set(["theoddsapi", "thesportsdb"]));
    for (const r of reports) expect(Object.keys(r).sort()).toEqual(["digest", "fetchedAt", "id", "outcome", "provider", "questionId", "status"]); // no raw payload column
  });

  test("polymarket: registered while open, resolved on Gamma AND the on-chain payout, then proposed", async () => {
    const m = pmMarkets[0]!;
    const endIso = new Date((Number(await env.chain.now()) + 3600) * 1000).toISOString();
    const open = { ...m.gamma, closed: false, umaResolutionStatus: "", outcomePrices: '["0.55","0.45"]', endDate: endIso, liquidityNum: 50_000, volumeNum: 250_000 };
    env.setSources({ gamma: { [m.gamma.slug]: open }, ctf: { [m.gamma.conditionId]: { den: 0n, yes: 0n, no: 0n } } });
    const q = await ensurePolymarketQuestion(env.deps, m.gamma.slug);
    await createOutcomeEscrow(env, q.id, BigInt(q.earliestResolve + 30 * 86400));
    await indexerTick(env.deps, async () => {});
    await env.chain.warpTo(BigInt(q.earliestResolve + 1));

    // Gamma says resolved but the chain has no payout yet: wait for both
    env.setSources({ gamma: { [m.gamma.slug]: { ...m.gamma, endDate: endIso } }, ctf: { [m.gamma.conditionId]: { den: 0n, yes: 0n, no: 0n } } });
    await resolverTick(env.deps);
    expect((await onchainState(env, q.id))[0]).toBe(1);

    env.setSources({ gamma: { [m.gamma.slug]: { ...m.gamma, endDate: endIso } } });
    await resolverTick(env.deps);
    const c = await questionOnchain(env, q.id);
    expect([Number(c.state), Number(c.proposed)]).toEqual([2, JSON.parse(m.gamma.outcomePrices)[0] === "1" ? 1 : 2]);
  });
});
