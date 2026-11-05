// R5: a disputed question the panel leaves unanswered for 72 h is voided by finalizeTimedOut (each side gets half its
// bond back, audit M-1; the other halves are forfeited to the FeeRouter) and the
// payment on it refunds through the keeper. The panel-SLA monitor runs from the stored dispute time, not from the
// earliest resolve time.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { questions } from "../src/db/schema";
import { runMonitors, PANEL_SLA_MS } from "../src/ops/monitors";
import { indexerTick, resetIndexerState } from "../src/workers/indexer";
import { keeperTick } from "../src/workers/keeper";
import { resolverTick } from "../src/workers/resolver";
import { haveAnvil, havePostgres } from "./helpers/chain";
import { bootResolverEnv, createOutcomeEscrow, escrowStatus, onchainState, proposeAs, questionOnchain, rowOf, Status, type ResolverEnv } from "./helpers/resolverHarness";
import { eplEvents, expectedFootball } from "./helpers/resolverFixtures";

setDefaultTimeout(120_000);

describe.skipIf(!haveAnvil() || !havePostgres())("resolver panel timeout (R5)", () => {
  let env: ResolverEnv;
  beforeAll(async () => {
    resetIndexerState();
    env = await bootResolverEnv();
  });
  afterAll(async () => env?.stop());

  test("panel silent for 72 h: VOID, half of each bond back, the rest forfeited, payment refunded through the keeper; SLA alert counts from the dispute", async () => {
    const q = await env.question(0);
    const escrowId = await createOutcomeEscrow(env, q.id, BigInt(q.earliestResolve) + 30n * 86400n);
    const truth = expectedFootball(eplEvents[0]!);
    await env.chain.warpTo(BigInt(q.earliestResolve + 1));
    await proposeAs(env, env.chain.bob, q.id, truth === 1 ? 2 : 1);
    const start = await env.chain.balance(env.resolverAddress);

    await resolverTick(env.deps); // disputes
    const disputed = await questionOnchain(env, q.id);
    expect(Number(disputed.state)).toBe(3);
    const disputedAt = Number(disputed.disputedAt);
    expect((await rowOf(env, q.id)).disputedAt?.getTime()).toBe(disputedAt * 1000);

    // 10 hours in: still waiting, one ops note, nothing sent
    await env.chain.warpTo(BigInt(disputedAt + 10 * 3600));
    await resolverTick(env.deps);
    await resolverTick(env.deps);
    expect(env.alerts.filter(([c]) => c === `panel-waiting:${q.id}`).length).toBe(1);
    expect((await onchainState(env, q.id))[0]).toBe(3);

    // SLA monitor: the question became decidable long ago (earliest_resolve proxy) but was disputed only 10 hours ago
    await env.pg.db.update(questions).set({ earliestResolve: new Date((disputedAt - 5 * 86400) * 1000) }).where(eq(questions.id, q.id));
    await runMonitors(env.deps, async (c, t) => (env.alerts.push([c, t]), true), new Date((disputedAt + 10 * 3600) * 1000));
    expect(env.alerts.some(([c]) => c === "panel-sla")).toBe(false);
    await runMonitors(env.deps, async (c, t) => (env.alerts.push([c, t]), true), new Date(disputedAt * 1000 + PANEL_SLA_MS + 3600_000));
    expect(env.alerts.filter(([c]) => c === "panel-sla").length).toBe(1);

    // 72 h after the dispute
    await env.chain.warpTo(BigInt(disputedAt + 72 * 3600));
    await resolverTick(env.deps);
    expect((await onchainState(env, q.id))[0]).toBe(5); // VOID
    const row = await rowOf(env, q.id);
    expect(row.state).toBe(5);
    expect(row.finalOutcome).toBeNull();
    // audit M-1: half of the service's own bond came back (the proposer has half of its bond to withdraw); the other
    // two halves sit in `forfeited` for the FeeRouter
    const { ifsoOutcomeResolverAbi } = await import("../src/abi");
    expect(await env.chain.balance(env.resolverAddress)).toBe(start - 5_000_000n);
    expect(await env.chain.pc.readContract({ address: env.chain.resolver, abi: ifsoOutcomeResolverAbi, functionName: "claimableBond", args: [env.chain.bob.address] })).toBe(5_000_000n);
    expect(await env.chain.pc.readContract({ address: env.chain.resolver, abi: ifsoOutcomeResolverAbi, functionName: "forfeited" })).toBe(10_000_000n);
    // the float lost half a bond to panel silence: a human is told (once)
    await resolverTick(env.deps);
    const silent = env.alerts.filter(([c]) => c === `resolver-panel-silent:${q.id}`);
    expect(silent.length).toBe(1);
    expect(silent[0]![1]).toContain("5000000 USDG units");

    // the payment on the voided question refunds through the keeper
    await indexerTick(env.deps, async () => {});
    const before = await env.chain.balance(env.chain.sender.address);
    await keeperTick(env.deps);
    expect(await escrowStatus(env, escrowId)).toBe(Status.RETURNED);
    expect((await env.chain.balance(env.chain.sender.address)) - before).toBeGreaterThanOrEqual(20_000_000n);
  });
});
