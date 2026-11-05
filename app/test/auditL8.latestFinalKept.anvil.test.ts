// Audit L-8 regression (PoC of 4318745): the resolver once substituted a provider's FIRST final read for a later pending
// one, not its LATEST final read. A provider that corrected its result (final A, then final B) and later reads pending
// (The Odds API drops the game after 3 days, or any fetch error) was put back to the superseded result A, the sources
// disagreed and nothing was proposed. Now the latest final is kept, and a later pending read never downgrades it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agree } from "../src/core/outcome";
import { questions } from "../src/db/schema";
import { toReport as oddsReport } from "../src/sources/theOddsApi";
import { toReport as sdbReport } from "../src/sources/theSportsDb";
import type { SourceFetchers } from "../src/sources";
import { gatherReports, resolverTick } from "../src/workers/resolver";
import { haveAnvil, havePostgres } from "./helpers/chain";
import { bootResolverEnv, questionOnchain, type ResolverEnv } from "./helpers/resolverHarness";
import { digestOf, eplEvents, expectedFootball, oddsScores } from "./helpers/resolverFixtures";

setDefaultTimeout(180_000);
const DAY = 86400;

describe.skipIf(!haveAnvil() || !havePostgres())("L-8: a corrected provider result is kept over the superseded first final", () => {
  let env: ResolverEnv;
  beforeAll(async () => {
    env = await bootResolverEnv();
  });
  afterAll(async () => env?.stop());

  async function run(i: number, withEarlyWrongRead: boolean) {
    const q = await env.question(i);
    const e = eplEvents[i]!;
    const truth = expectedFootball(e);
    const kickoff = q.closeTime;
    const odds = oddsScores.find((s) => s._derivedFrom === e.idEvent)!;
    // a wrong early final (home/away scores swapped, or a draw turned into a home win)
    const h = Number(e.intHomeScore), a = Number(e.intAwayScore);
    const wrongScores = h === a ? [{ name: odds.home_team, score: String(h + 1) }, { name: odds.away_team, score: String(a) }] : [{ name: odds.home_team, score: String(a) }, { name: odds.away_team, score: String(h) }];
    const oddsWrong = { ...odds, scores: wrongScores };
    let clock = 0;
    const sdbLate = { ...e, strStatus: "Not Started", intHomeScore: null, intAwayScore: null };
    env.deps.sources = {
      ...env.deps.sources!,
      async oddsScore(_k, _s, id) {
        const ev = clock <= kickoff + 3 * DAY ? (withEarlyWrongRead && clock < kickoff + DAY ? oddsWrong : odds) : undefined;
        const body = ev ? [ev] : [];
        return oddsReport(body.find((x) => x.id === id), digestOf(body), clock);
      },
      async sportsDbEvent() {
        const ev = clock < kickoff + 4 * DAY ? sdbLate : e;
        return sdbReport(ev, digestOf(ev), clock);
      },
    } as SourceFetchers;

    clock = kickoff + 3 * 3600; // Odds API final (wrong in the attack run), TheSportsDB late
    await env.chain.warpTo(BigInt(clock));
    await resolverTick(env.deps);
    clock = kickoff + 2 * DAY; // Odds API corrected to the true result, TheSportsDB still late
    await env.chain.warpTo(BigInt(clock));
    await resolverTick(env.deps);
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(1);

    clock = kickoff + 4 * DAY; // Odds API forgot the game (pending), TheSportsDB final with the true result
    await env.chain.warpTo(BigInt(clock));
    const [row] = await env.pg.db.select().from(questions).where(eq(questions.id, q.id));
    const reads = await gatherReports(env.deps, row!);
    const ag = agree(reads);
    await resolverTick(env.deps);
    const o = await questionOnchain(env, q.id);
    return { truth, oddsUsed: reads.find((r) => r.provider === "theoddsapi")!, a: ag, state: Number(o.state), proposed: Number(o.proposed) };
  }

  test("control: no early wrong read -> proposes the true result at +4 d", async () => {
    const r = await run(1, false);
    expect(r.oddsUsed.outcome).toBe(r.truth);
    expect(r.state).toBe(2);
    expect(r.proposed).toBe(r.truth);
  });

  test("corrected early final: the latest final is used at +4 d, sources agree, the true result is proposed", async () => {
    const r = await run(2, true);
    expect(r.oddsUsed.status).toBe("final");
    expect(r.oddsUsed.outcome).toBe(r.truth); // the +2 d corrected final, not the superseded first one
    expect(r.a.conflict).toBeFalsy();
    expect(r.state).toBe(2);
    expect(r.proposed).toBe(r.truth);
  });
});
