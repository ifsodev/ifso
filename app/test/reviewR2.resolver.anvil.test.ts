// Review round 2, R2-H1 regression: the resolver service never lets a proposal by another address finalize unless its
// own sources confirm it (two final, agreeing sources). Contradicted, pending, unavailable or conflicting sources mean
// a bonded dispute inside the window; a short bond float raises an alert; every foreign proposal raises an ops alert.
// The first test is the round-2 PoC (it failed on 42567c1: FINAL with the wrong outcome, no alert).
// Round 3 (R3-H1, DECISIONS #32): an UNCONFIRMED proposal is no longer disputed at once; it is re-checked every tick and
// disputed in the last-call slot (RESOLVER_LAST_CALL_SECONDS before the window closes) if still unconfirmed.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { erc20Abi, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolverTick } from "../src/workers/resolver";
import { indexerTick } from "../src/workers/indexer";
import { haveAnvil, havePostgres } from "./helpers/chain";
import { bootResolverEnv, onchainState, proposeAs, questionOnchain, warpToLastCall, type ResolverEnv } from "./helpers/resolverHarness";
import { eplEvents, expectedFootball } from "./helpers/resolverFixtures";

setDefaultTimeout(120_000);

describe.skipIf(!haveAnvil() || !havePostgres())("R2-H1: unverifiable stranger proposals", () => {
  let env: ResolverEnv;
  beforeAll(async () => {
    env = await bootResolverEnv();
  });
  afterAll(async () => env?.stop());

  test("a wrong proposal made while one source is still pending does not become the final result", async () => {
    const q = await env.question(0); // a funded escrow sits on it (unlocks on HOME)
    const truth = expectedFootball(eplEvents[0]!);
    const wrong = truth === 1 ? 2 : 1;
    await env.chain.warpTo(BigInt(q.earliestResolve + 1));
    env.setSources({ down: ["tsdb"] }); // the second source has not published the result yet (lag, outage, rate limit)
    await proposeAs(env, env.chain.bob, q.id, wrong); // the losing party proposes its own answer at earliestResolve
    await resolverTick(env.deps);
    // audit M-2: the source that is final contradicts it and none backs it, so it is disputed at once
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(3);
    await env.chain.warpTo((await env.chain.now()) + 7300n); // dispute window (2 h) passes
    env.setSources(); // the lagging source is back, too late
    await resolverTick(env.deps);
    const [state, outcome] = await onchainState(env, q.id);
    expect(state === 4 && outcome === wrong).toBe(false);
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(3); // disputed: the panel decides, silence => VOID
    expect(env.alerts.some(([c]) => c.includes(q.id))).toBe(true);
  });

  test("every source down: a correct-looking foreign proposal is still disputed (cannot confirm)", async () => {
    const q = await env.question(1);
    await env.chain.warpTo(BigInt(Math.max(Number(await env.chain.now()), q.earliestResolve + 1)));
    env.setSources({ down: ["tsdb", "odds"] });
    await proposeAs(env, env.chain.bob, q.id, expectedFootball(eplEvents[1]!));
    await indexerTick(env.deps, async () => {}); // the indexer marks it state 2: the foreign pass sees it first
    await resolverTick(env.deps);
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(2);
    await warpToLastCall(env, q.id);
    await resolverTick(env.deps);
    const o = await questionOnchain(env, q.id);
    expect(Number(o.state)).toBe(3);
    expect(o.disputer.toLowerCase()).toBe(env.resolverAddress.toLowerCase());
    expect(env.alerts.some(([c]) => c.startsWith(`resolver-foreign:${q.id}`))).toBe(true);
    env.setSources();
  });

  test("sources final and agreeing with the foreign proposal: not disputed, finalized after the window", async () => {
    const q = await env.question(2);
    const truth = expectedFootball(eplEvents[2]!);
    await env.chain.warpTo(BigInt(Math.max(Number(await env.chain.now()), q.earliestResolve + 1)));
    env.setSources();
    await proposeAs(env, env.chain.bob, q.id, truth);
    await resolverTick(env.deps);
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(2);
    await env.chain.warpTo((await env.chain.now()) + 7300n);
    await resolverTick(env.deps);
    expect(await onchainState(env, q.id)).toEqual([4, truth]);
  });

  test("bond float too small: no dispute is possible, so a human is told at once (and the proposal is never finalized by us)", async () => {
    const q = await env.question(3);
    const truth = expectedFootball(eplEvents[3]!);
    const wrong = truth === 1 ? 2 : 1;
    await env.chain.warpTo(BigInt(Math.max(Number(await env.chain.now()), q.earliestResolve + 1)));
    env.setSources({ down: ["tsdb"] });
    const me = privateKeyToAccount(env.chain.resolverKey);
    const bal = await env.chain.balance(me.address);
    await env.chain.write(me, env.chain.usdg, erc20Abi as Abi, "transfer", [env.chain.bob.address, bal]);
    await proposeAs(env, env.chain.bob, q.id, wrong);
    await resolverTick(env.deps);
    await warpToLastCall(env, q.id);
    await resolverTick(env.deps);
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(2);
    // audit M-2: the final source contradicts the proposal, so it is "contradicted": with no bond left a human is told
    // at once (resolver-bond-short), not only in the last-call slot
    expect(env.alerts.some(([c, m]) => c === "resolver-bond-short" && String(m).includes(q.id))).toBe(true);
    await env.chain.warpTo((await env.chain.now()) + 7300n);
    await resolverTick(env.deps);
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(2); // the service does not finalize it
    expect(env.alerts.some(([c]) => c.startsWith(`resolver-unconfirmed-open:${q.id}`))).toBe(true);
    env.setSources();
  });
});
