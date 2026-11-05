// Audit M-1 (app side): forfeited bond halves accrue in the resolver's `forfeited`; the keeper forwards them to the
// FeeRouter with forwardForfeits() when forfeited() > 0 (guarded, simulate first, at most every FORFEIT_CHECK_MS),
// and the indexer keeps BondForfeited and ForfeitsForwarded in chain_events.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { ifsoOutcomeResolverAbi } from "../src/abi";
import { chainEvents, relayTxs } from "../src/db/schema";
import { indexerTick, resetIndexerState } from "../src/workers/indexer";
import { keeperTick, resetKeeperBackoff } from "../src/workers/keeper";
import { resolverTick } from "../src/workers/resolver";
import { haveAnvil, havePostgres } from "./helpers/chain";
import { bootResolverEnv, proposeAs, questionOnchain, type ResolverEnv } from "./helpers/resolverHarness";
import { eplEvents, expectedFootball } from "./helpers/resolverFixtures";

setDefaultTimeout(120_000);

describe.skipIf(!haveAnvil() || !havePostgres())("audit M-1: forfeits reach the FeeRouter through the keeper", () => {
  let env: ResolverEnv;
  beforeAll(async () => {
    resetIndexerState();
    resetKeeperBackoff();
    env = await bootResolverEnv();
  });
  afterAll(async () => env?.stop());

  const forfeited = () => env.chain.pc.readContract({ address: env.chain.resolver, abi: ifsoOutcomeResolverAbi, functionName: "forfeited" }) as Promise<bigint>;
  const forwards = () => env.deps.db.select().from(chainEvents).where(eq(chainEvents.name, "ForfeitsForwarded"));

  test("nothing forfeited: the keeper sends no forwardForfeits", async () => {
    expect(await forfeited()).toBe(0n);
    await keeperTick(env.deps);
    await indexerTick(env.deps, async () => {});
    expect((await forwards()).length).toBe(0);
  });

  test("panel silence: both halves forfeited, indexed, then forwarded by the keeper once", async () => {
    const q = await env.question(0);
    const truth = expectedFootball(eplEvents[0]!);
    await env.chain.warpTo(BigInt(q.earliestResolve + 1));
    await proposeAs(env, env.chain.bob, q.id, truth === 1 ? 2 : 1);
    await resolverTick(env.deps); // the service disputes the contradicted proposal
    const d = await questionOnchain(env, q.id);
    expect(Number(d.state)).toBe(3);
    await env.chain.warpTo(d.disputedAt + 72n * 3600n);
    await resolverTick(env.deps); // finalizeTimedOut
    expect(await forfeited()).toBe(10_000_000n); // ceil(bond / 2) of each 10 USDG side

    await indexerTick(env.deps, async () => {});
    const bf = await env.deps.db.select().from(chainEvents).where(and(eq(chainEvents.name, "BondForfeited")));
    expect(bf.length).toBe(1);
    expect((bf[0]!.args as { questionId: string; amount: string }).questionId.toLowerCase()).toBe(q.id.toLowerCase());
    expect((bf[0]!.args as { amount: string }).amount).toBe("10000000");

    const routerBefore = await env.chain.balance(env.chain.router);
    resetKeeperBackoff(); // the first test's check started the FORFEIT_CHECK_MS clock
    await keeperTick(env.deps);
    expect(await forfeited()).toBe(0n);
    expect((await env.chain.balance(env.chain.router)) - routerBefore).toBe(10_000_000n);
    const sent = await env.deps.db.select().from(relayTxs).where(eq(relayTxs.kind, "forward-forfeits"));
    expect(sent.map((r) => r.status)).toEqual(["sent"]);

    await indexerTick(env.deps, async () => {});
    const fw = await forwards();
    expect(fw.length).toBe(1);
    expect((fw[0]!.args as { feeRouter: string; amount: string }).feeRouter.toLowerCase()).toBe(env.chain.router.toLowerCase());
    expect((fw[0]!.args as { amount: string }).amount).toBe("10000000");

    // a second tick inside the check interval reads nothing and sends nothing
    await keeperTick(env.deps);
    await indexerTick(env.deps, async () => {});
    expect((await forwards()).length).toBe(1);
  });
});
