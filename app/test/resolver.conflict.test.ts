// R2: any disagreement between independent sources means no proposal and ONE ops alert. A provider that is down
// (or not final yet) is not a conflict: no proposal, no alert. Once the sources agree the proposal goes through.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ifsoOutcomeResolverAbi } from "../src/abi";
import { relayTxs } from "../src/db/schema";
import { resolverTick } from "../src/workers/resolver";
import { haveAnvil, havePostgres } from "./helpers/chain";
import { bootResolverEnv, onchainState, type ResolverEnv } from "./helpers/resolverHarness";
import { eplEvents, expectedFootball } from "./helpers/resolverFixtures";

setDefaultTimeout(120_000);

const swapped = (i: number) => {
  const e = eplEvents[i]!;
  const want = expectedFootball(e);
  // a different, still-final scoreline
  return want === 1 ? { ...e, intHomeScore: "0", intAwayScore: "2" } : { ...e, intHomeScore: "3", intAwayScore: "0" };
};

describe.skipIf(!haveAnvil() || !havePostgres())("resolver conflicts (R2)", () => {
  let env: ResolverEnv;
  let ids: Array<`0x${string}`> = [];
  beforeAll(async () => {
    env = await bootResolverEnv();
  });
  afterAll(async () => env?.stop());

  test("sources contradict: no proposal, exactly one alert across repeated ticks; a down provider is not a conflict", async () => {
    const q0 = await env.question(0); //  two different results
    const q1 = await env.question(1); //  one says final, the other says postponed
    const q2 = await env.question(2); //  one provider down
    env.setSources({
      tsdb: { [eplEvents[0]!.idEvent]: swapped(0), [eplEvents[1]!.idEvent]: { ...eplEvents[1]!, strStatus: "Postponed", strPostponed: "yes" } },
      down: [], // q2 handled below
    });
    // q2: Odds API unreachable only for that fixture -> make it throw by pointing the id at a provider flag
    const base = env.deps.sources!;
    env.deps.sources = { ...base, oddsScore: async (k, s, id) => { if (id === q2.fixture.oddsApiEventId) throw new Error("odds is down"); return base.oddsScore(k, s, id); } };

    await env.chain.warpTo(BigInt(Math.max(q0.earliestResolve, q1.earliestResolve, q2.earliestResolve) + 1));
    for (let i = 0; i < 3; i++) await resolverTick(env.deps);

    ids = [q0.id, q1.id, q2.id];
    for (const q of [q0, q1, q2]) expect((await onchainState(env, q.id))[0]).toBe(1); // still OPEN: nothing proposed
    const sent = await env.pg.db.select().from(relayTxs).where(eq(relayTxs.kind, "propose"));
    expect(sent.length).toBe(0);
    const conflicts = env.alerts.filter(([c]) => c.startsWith("resolver-conflict:"));
    expect(conflicts.map(([c]) => c).sort()).toEqual([`resolver-conflict:${q0.id}`, `resolver-conflict:${q1.id}`].sort());
    expect(env.alerts.some(([c]) => c.includes(q2.id))).toBe(false);
  });

  test("once the sources agree the proposal is made", async () => {
    env.setSources(); // recorded data again: both sources agree for every fixture
    await resolverTick(env.deps);
    const rows = await env.pg.db.select().from(relayTxs).where(eq(relayTxs.kind, "propose"));
    expect(rows.length).toBe(3);
    for (const [i, id] of ids.entries()) {
      const q = await env.chain.pc.readContract({ address: env.chain.resolver, abi: ifsoOutcomeResolverAbi, functionName: "getQuestion", args: [id] });
      expect(Number(q.state)).toBe(2);
      expect(Number(q.proposed)).toBe(expectedFootball(eplEvents[i]!));
      expect(q.sourcesHash).not.toBe(`0x${"0".repeat(64)}`);
    }
  });
});
