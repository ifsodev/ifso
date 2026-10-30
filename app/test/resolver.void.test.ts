// R3: postponed / abandoned fixtures take the VOID path: never a team outcome. One source saying "postponed" while
// the other is merely late is not enough to propose anything; two sources saying void propose outcome 0, which
// finalizes and refunds the payment through the keeper.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ifsoOutcomeResolverAbi } from "../src/abi";
import { agree } from "../src/core/outcome";
import { relayTxs } from "../src/db/schema";
import { toReport as oddsReport } from "../src/sources/theOddsApi";
import { toReport as sdbReport } from "../src/sources/theSportsDb";
import { indexerTick, resetIndexerState } from "../src/workers/indexer";
import { keeperTick } from "../src/workers/keeper";
import { resolverTick } from "../src/workers/resolver";
import { haveAnvil, havePostgres } from "./helpers/chain";
import { bootResolverEnv, createOutcomeEscrow, escrowStatus, onchainState, Status, type ResolverEnv } from "./helpers/resolverHarness";
import { eplEvents, oddsScores } from "./helpers/resolverFixtures";

setDefaultTimeout(120_000);

const postponed = (i: number) => ({ ...eplEvents[i]!, strStatus: "PST", strPostponed: "yes", intHomeScore: null, intAwayScore: null });
const abandoned = (i: number) => ({ ...eplEvents[i]!, strStatus: "Abandoned", strPostponed: "no" });
const notPlayedOdds = (i: number, commence: string) => {
  const o = oddsScores.find((s) => s._derivedFrom === eplEvents[i]!.idEvent)!;
  return { ...o, completed: false, scores: null, commence_time: commence };
};

describe("source statuses map to void", () => {
  test("TheSportsDB: postponed flag, PST, abandoned, cancelled, suspended", () => {
    for (const e of [postponed(0), abandoned(0), { ...eplEvents[0]!, strStatus: "Cancelled" }, { ...eplEvents[0]!, strStatus: "ABD" }, { ...eplEvents[0]!, strStatus: "FT", strPostponed: "yes" }]) {
      expect(sdbReport(e, "0x01", 1).status).toBe("void");
    }
    expect(sdbReport(eplEvents[0]!, "0x01", 1).status).toBe("final");
  });
  test("Odds API: not completed a day after kickoff is void, earlier it is only pending", () => {
    const kickoff = Date.parse("2026-11-01T15:00:00Z") / 1000;
    const e = notPlayedOdds(0, "2026-11-01T15:00:00Z");
    expect(oddsReport(e, "0x01", kickoff + 3 * 3600).status).toBe("pending");
    expect(oddsReport(e, "0x01", kickoff + 25 * 3600).status).toBe("void");
  });
  test("a lone void never proposes; two voids propose outcome 0 only", () => {
    const v = sdbReport(postponed(0), "0x01", 1);
    const late = oddsReport(notPlayedOdds(0, "2026-11-01T15:00:00Z"), "0x01", Date.parse("2026-11-01T18:00:00Z") / 1000);
    expect(agree([v, late]).decision).toBeNull();
    const out = agree([v, { ...late, status: "void" }]);
    expect(out.decision).toBe(0);
  });
});

describe.skipIf(!haveAnvil() || !havePostgres())("resolver VOID path on anvil (R3)", () => {
  let env: ResolverEnv;
  beforeAll(async () => {
    resetIndexerState();
    env = await bootResolverEnv();
  });
  afterAll(async () => env?.stop());

  test("one source postponed + the other late: nothing proposed. Both void: outcome 0, finalized, payment refunded", async () => {
    const q0 = await env.question(0); // postponed in TheSportsDB, Odds API only late
    const q1 = await env.question(1); // postponed in both
    const q2 = await env.question(2); // abandoned in both
    const expiry = BigInt(q1.earliestResolve) + 30n * 86400n;
    const escrowId = await createOutcomeEscrow(env, q1.id, expiry);
    const t0 = Math.max(q0.earliestResolve, q1.earliestResolve, q2.earliestResolve) + 1;
    env.setSources({
      tsdb: { [eplEvents[0]!.idEvent]: postponed(0), [eplEvents[1]!.idEvent]: postponed(1), [eplEvents[2]!.idEvent]: abandoned(2) },
      // the Odds API clock is wall-clock, so "late" means kickoff just now and "void" means kickoff days ago
      odds: {
        [q0.fixture.oddsApiEventId]: notPlayedOdds(0, new Date().toISOString()),
        [q1.fixture.oddsApiEventId]: notPlayedOdds(1, "2024-08-17T15:00:00Z"),
        [q2.fixture.oddsApiEventId]: notPlayedOdds(2, "2024-08-17T15:00:00Z"),
      },
    });
    await env.chain.warpTo(BigInt(t0));
    await resolverTick(env.deps);

    expect((await onchainState(env, q0.id))[0]).toBe(1); // still OPEN: no proposal of any kind
    for (const q of [q1, q2]) {
      const c = await env.chain.pc.readContract({ address: env.chain.resolver, abi: ifsoOutcomeResolverAbi, functionName: "getQuestion", args: [q.id] });
      expect(Number(c.state)).toBe(2);
      expect(Number(c.proposed)).toBe(0); // VOID, never HOME / AWAY / DRAW
    }
    const proposals = await env.pg.db.select().from(relayTxs).where(eq(relayTxs.kind, "propose"));
    expect(proposals.length).toBe(2);

    // finalize after the 2 h window, then the keeper settles the payment as void
    await env.chain.warpTo(BigInt(t0) + 7300n);
    await resolverTick(env.deps);
    expect(await onchainState(env, q1.id)).toEqual([4, 0]);
    await indexerTick(env.deps, async () => {});
    const before = await env.chain.balance(env.chain.sender.address);
    await keeperTick(env.deps);
    expect(await escrowStatus(env, escrowId)).toBe(Status.RETURNED); // one-sided payment: all of it comes back to the sender
    expect((await env.chain.balance(env.chain.sender.address)) - before).toBeGreaterThanOrEqual(20_000_000n);
    expect(env.alerts.filter(([c]) => c.startsWith("resolver-conflict")).length).toBe(0);
  });
});
