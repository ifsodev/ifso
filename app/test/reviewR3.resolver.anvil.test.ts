// Review round 3, R3-H1 regression (the two PoCs from docs/reviews/pocs-r3, inverted; both FAILED on c5bf754).
// The R2-H1 fix disputed every foreign proposal its sources could not confirm yet, so anyone proposing the CORRECT
// answer at earliestResolve while a source was still pending earned the service's bond, until the float was gone and a
// WRONG proposal went through. Fix (DECISIONS #32, option A): contradicted proposals are disputed at once; unconfirmed
// ones are re-checked every tick and disputed only in the last-call slot, within a budget that always keeps one bond for
// a contradicted proposal; over budget a human is paged.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { erc20Abi, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ifsoOutcomeResolverAbi } from "../src/abi";
import { resolverTick } from "../src/workers/resolver";
import { indexerTick } from "../src/workers/indexer";
import { haveAnvil, havePostgres } from "./helpers/chain";
import { bootResolverEnv, createOutcomeEscrow, onchainState, proposeAs, questionOnchain, warpToLastCall, type ResolverEnv } from "./helpers/resolverHarness";
import { eplEvents, expectedFootball } from "./helpers/resolverFixtures";

setDefaultTimeout(180_000);

const claimable = (env: ResolverEnv, who: `0x${string}`) =>
  env.chain.pc.readContract({ address: env.chain.resolver, abi: ifsoOutcomeResolverAbi, functionName: "claimableBond", args: [who] }) as Promise<bigint>;
const pendingTsdb = (...i: number[]) => ({ tsdb: Object.fromEntries(i.map((k) => [eplEvents[k]!.idEvent, undefined])) });

describe.skipIf(!haveAnvil() || !havePostgres())("R3-H1: honest early proposals no longer drain the resolver bond float", () => {
  let env: ResolverEnv;
  beforeAll(async () => {
    env = await bootResolverEnv();
  });
  afterAll(async () => env?.stop());

  test("a CORRECT foreign proposal made while a source is pending is not disputed once the source confirms it; the float stays intact", async () => {
    const q = await env.question(0);
    const truth = expectedFootball(eplEvents[0]!);
    const before = await env.chain.balance(env.resolverAddress);
    await env.chain.warpTo(BigInt(q.earliestResolve + 1));
    env.setSources({ down: ["tsdb"] }); // the normal state right after earliestResolve
    await proposeAs(env, env.chain.bob, q.id, truth);
    await indexerTick(env.deps, async () => {});
    await resolverTick(env.deps);
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(2); // not disputed: re-checked every tick
    await env.chain.warpTo((await env.chain.now()) + 1800n);
    env.setSources(); // the lagging source publishes before the last-call slot
    await resolverTick(env.deps);
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(2);
    await env.chain.warpTo((await env.chain.now()) + 7300n);
    await resolverTick(env.deps); // confirmed: the service finalizes it
    expect(await onchainState(env, q.id)).toEqual([4, truth]);
    expect(await claimable(env, env.resolverAddress)).toBe(0n);
    expect(await env.chain.balance(env.resolverAddress)).toBe(before); // SAFE: no bond paid to an honest proposer
  });

  test("float down to two bonds: the wrong last-call proposal is disputed, the next one pages a human, and the spare bond still disputes a contradicted WRONG proposal", async () => {
    const [q1, q2, q3] = [await env.question(1), await env.question(2), await env.question(3)];
    await createOutcomeEscrow(env, q2.id, BigInt(q2.earliestResolve + 30 * 86400)); // more USDG on q2: it goes first
    await indexerTick(env.deps, async () => {});
    const truth = (i: number) => expectedFootball(eplEvents[i]!);
    const wrongOf = (t: number) => (t === 1 ? 2 : 1);
    const bond = (await env.chain.pc.readContract({ address: env.chain.resolver, abi: ifsoOutcomeResolverAbi, functionName: "bondAmount" })) as bigint;
    const me = privateKeyToAccount(env.chain.resolverKey);
    const extra = (await env.chain.balance(me.address)) - 2n * bond; // the attacker already used up the rest
    await env.chain.write(me, env.chain.usdg, erc20Abi as Abi, "transfer", [env.chain.deployer.address, extra]);
    await env.chain.warpTo(BigInt(Math.max(Number(await env.chain.now()), q1.earliestResolve + 1, q2.earliestResolve + 1, q3.earliestResolve + 1)));

    env.setSources(pendingTsdb(1, 2, 3)); // q1 and q2 stay unconfirmed to the end (e.g. a disputed result upstream); q3 for now
    await proposeAs(env, env.chain.bob, q1.id, truth(1)); // honest
    await proposeAs(env, env.chain.bob, q2.id, wrongOf(truth(2))); // wrong
    await indexerTick(env.deps, async () => {});
    await resolverTick(env.deps);
    expect([Number((await questionOnchain(env, q1.id)).state), Number((await questionOnchain(env, q2.id)).state)]).toEqual([2, 2]);

    await warpToLastCall(env, q1.id);
    await resolverTick(env.deps);
    expect(Number((await questionOnchain(env, q2.id)).state)).toBe(3); // most USDG first, from the budget
    expect(Number((await questionOnchain(env, q1.id)).state)).toBe(2); // over budget
    expect(env.alerts.some(([c]) => c.startsWith(`resolver-dispute-budget:${q1.id}`))).toBe(true); // a human is paged
    expect(await env.chain.balance(me.address)).toBe(bond); // SAFE: last-call disputes never touch the last bond

    await proposeAs(env, env.chain.bob, q3.id, wrongOf(truth(3)));
    env.setSources(pendingTsdb(1, 2)); // q3's sources are final: contradicted
    await indexerTick(env.deps, async () => {});
    await resolverTick(env.deps);
    expect(Number((await questionOnchain(env, q3.id)).state)).toBe(3); // disputed from the reserved bond
    expect(await env.chain.balance(me.address)).toBe(0n);

    // the panel rules on the truth: the service gets both bonds back on q2 and q3
    for (const [q, t] of [[q2, truth(2)], [q3, truth(3)]] as const)
      await env.chain.write(env.chain.deployer, env.chain.resolver, ifsoOutcomeResolverAbi as Abi, "panelResolve", [q.id, t]);
    expect(await claimable(env, me.address)).toBe(4n * bond);
    for (const [q, t] of [[q2, truth(2)], [q3, truth(3)]] as const) expect(await onchainState(env, q.id)).toEqual([4, t]); // SAFE: a wrong answer never becomes final
    await env.chain.warpTo((await env.chain.now()) + 7300n);
    await resolverTick(env.deps); // q1's window closed unconfirmed: never finalized by us, a human is told
    expect(Number((await questionOnchain(env, q1.id)).state)).toBe(2);
    expect(env.alerts.some(([c]) => c.startsWith(`resolver-unconfirmed-open:${q1.id}`))).toBe(true);
    env.setSources();
  });

  test("a last-call dispute the panel rejects raises a float alert", async () => {
    const q = await env.question(4);
    const truth = expectedFootball(eplEvents[4]!);
    await env.chain.mint(env.resolverAddress, 100);
    await env.chain.warpTo(BigInt(Math.max(Number(await env.chain.now()), q.earliestResolve + 1)));
    env.setSources(pendingTsdb(4));
    await proposeAs(env, env.chain.bob, q.id, truth);
    await indexerTick(env.deps, async () => {});
    await warpToLastCall(env, q.id);
    await resolverTick(env.deps);
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(3);
    await env.chain.write(env.chain.deployer, env.chain.resolver, ifsoOutcomeResolverAbi as Abi, "panelResolve", [q.id, truth]);
    await resolverTick(env.deps);
    expect(env.alerts.some(([c]) => c === `resolver-last-call-lost:${q.id}`)).toBe(true);
    env.setSources();
  });
});
