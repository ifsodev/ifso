// Since audit M-3 / L-4 an OUTCOME payment on a question that is not final steps aside (2 min doubling to 30 min) so no
// reads or gas go to open questions. Fork run 2026-11-04: after the question went final such a payment waited up to
// 30 more minutes. Now the wait ends as soon as the question is seen FINAL or VOID (the resolver's own finalize, or
// the indexer's Finalized / PanelTimedOut event), and the payment settles on the next keeper tick.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import type { Abi } from "viem";
import { ifsoOutcomeResolverAbi } from "../src/abi";
import { indexerTick } from "../src/workers/indexer";
import { keeperTick, resetKeeperBackoff } from "../src/workers/keeper";
import { resolverTick } from "../src/workers/resolver";
import { haveAnvil, havePostgres } from "./helpers/chain";
import { bootResolverEnv, createOutcomeEscrow, escrowStatus, questionOnchain, Status, type ResolverEnv } from "./helpers/resolverHarness";

setDefaultTimeout(180_000);
const MIN = 60_000;

describe.skipIf(!haveAnvil() || !havePostgres())("keeper: an outcome payment backed off at 30 min settles on the first tick after its question is final", () => {
  let env: ResolverEnv;
  let clock = Date.now();
  beforeAll(async () => {
    env = await bootResolverEnv();
  });
  afterEach(() => setSystemTime());
  afterAll(async () => env?.stop());

  /** Keeper ticks with the wall clock moved 31 min each time, so the row's wait doubles up to the 30 min cap. */
  async function backOffToCap(id: bigint) {
    resetKeeperBackoff();
    for (let i = 0; i < 6; i++) {
      clock += 31 * MIN;
      setSystemTime(new Date(clock));
      await keeperTick(env.deps);
      expect(await escrowStatus(env, id)).toBe(Status.OPEN); // not final: nothing sent
    }
  }
  /** One keeper tick 30 s later (well inside the 30 min wait), then the payment's status. */
  async function oneTick(id: bigint) {
    clock += 30_000;
    setSystemTime(new Date(clock));
    await keeperTick(env.deps);
    return escrowStatus(env, id);
  }

  test("the resolver's own finalize ends the wait", async () => {
    const q = await env.question(10, 3600, false);
    const id = await createOutcomeEscrow(env, q.id, BigInt(q.earliestResolve + 30 * 86400), 0b1110n); // any result unlocks it
    await indexerTick(env.deps, async () => {});
    await backOffToCap(id);

    await env.chain.warpTo(BigInt(q.earliestResolve + 1));
    await resolverTick(env.deps); // both sources agree: proposed
    const p = await questionOnchain(env, q.id);
    expect(Number(p.state)).toBe(2);
    await env.chain.warpTo(p.proposedAt + 7201n);
    await resolverTick(env.deps); // finalized by the service
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(4);
    await indexerTick(env.deps, async () => {});
    expect(await oneTick(id)).toBe(Status.RELEASED);
  });

  test("another address finalizing (seen by the indexer) ends the wait", async () => {
    const q = await env.question(11, 3600, false);
    const id = await createOutcomeEscrow(env, q.id, BigInt(q.earliestResolve + 30 * 86400), 0b1110n);
    await indexerTick(env.deps, async () => {});
    await backOffToCap(id);

    await env.chain.warpTo(BigInt(q.earliestResolve + 1));
    await resolverTick(env.deps);
    const p = await questionOnchain(env, q.id);
    await env.chain.warpTo(p.proposedAt + 7201n);
    await env.chain.fund(env.chain.alice.address);
    await env.chain.write(env.chain.alice, env.chain.resolver, ifsoOutcomeResolverAbi as Abi, "finalize", [q.id]); // permissionless
    await indexerTick(env.deps, async () => {});
    expect(await oneTick(id)).toBe(Status.RELEASED);
  });
});
