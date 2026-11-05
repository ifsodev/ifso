// R4: a proposal by another address that our sources contradict is disputed inside the window (with a matching
// bond); one that matches is left alone and finalized after the window. The panel then decides.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { ifsoOutcomeResolverAbi } from "../src/abi";
import { resolverTick } from "../src/workers/resolver";
import { haveAnvil, havePostgres } from "./helpers/chain";
import { bootResolverEnv, onchainState, proposeAs, questionOnchain, rowOf, type ResolverEnv } from "./helpers/resolverHarness";
import { eplEvents, expectedFootball } from "./helpers/resolverFixtures";
import type { Abi } from "viem";

setDefaultTimeout(120_000);

describe.skipIf(!haveAnvil() || !havePostgres())("resolver disputes contradicting proposals (R4)", () => {
  let env: ResolverEnv;
  beforeAll(async () => {
    env = await bootResolverEnv();
  });
  afterAll(async () => env?.stop());

  test("wrong proposal by another address: disputed; matching proposal: left alone and finalized", async () => {
    const wrongQ = await env.question(0);
    const rightQ = await env.question(1);
    const lateQ = await env.question(2);
    const truth = (i: number) => expectedFootball(eplEvents[i]!);
    const wrong = truth(0) === 1 ? 2 : 1;
    await env.chain.warpTo(BigInt(Math.max(wrongQ.earliestResolve, rightQ.earliestResolve, lateQ.earliestResolve) + 1));
    const who = env.chain.bob;
    await proposeAs(env, who, wrongQ.id, wrong);
    await proposeAs(env, who, rightQ.id, truth(1));
    const bondBefore = await env.chain.balance(env.resolverAddress);

    await resolverTick(env.deps);

    // contradicted -> disputed by the service with a matching bond
    const w = await questionOnchain(env, wrongQ.id);
    expect(Number(w.state)).toBe(3);
    expect(w.disputer.toLowerCase()).toBe(env.resolverAddress.toLowerCase());
    // two bonds left the service: one disputing the wrong proposal, one for its own proposal on the third fixture
    expect(bondBefore - (await env.chain.balance(env.resolverAddress))).toBe(20_000_000n);
    const own = await questionOnchain(env, lateQ.id);
    expect(Number(own.state)).toBe(2);
    expect(own.proposer.toLowerCase()).toBe(env.resolverAddress.toLowerCase());
    const row = await rowOf(env, wrongQ.id);
    expect(row.state).toBe(3);
    expect(row.disputedAt).not.toBeNull();
    expect(Math.floor(row.disputedAt!.getTime() / 1000)).toBe(Number(w.disputedAt));
    // matching -> untouched
    expect(Number((await questionOnchain(env, rightQ.id)).state)).toBe(2);

    // after the window the undisputed proposals finalize (the service's own bond comes back the same tick)
    await env.chain.warpTo((await env.chain.now()) + 7300n);
    await resolverTick(env.deps);
    expect(await onchainState(env, rightQ.id)).toEqual([4, truth(1)]); // finalized
    expect((await rowOf(env, rightQ.id)).finalOutcome).toBe(truth(1));

    // the panel (the deployer in this harness) sides with the service: audit M-1, the service gets its own bond plus
    // half the loser's (the other half is forfeited to the FeeRouter), then withdraws them
    await env.chain.write(env.chain.deployer, env.chain.resolver, ifsoOutcomeResolverAbi as Abi, "panelResolve", [wrongQ.id, truth(0)]);
    const before = await env.chain.balance(env.resolverAddress);
    await resolverTick(env.deps);
    expect((await env.chain.balance(env.resolverAddress)) - before).toBe(15_000_000n); // bond + bond/2 of the loser's
    expect(await env.chain.pc.readContract({ address: env.chain.resolver, abi: ifsoOutcomeResolverAbi, functionName: "forfeited" })).toBe(5_000_000n);
    expect((await rowOf(env, wrongQ.id)).state).toBe(4);
    expect((await rowOf(env, wrongQ.id)).finalOutcome).toBe(truth(0));
  });
});
