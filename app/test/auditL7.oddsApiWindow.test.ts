// Audit L-7: The Odds API /scores?daysFrom=3 drops a finished game after 3 days, so a later read finds no event and
// reads as pending. A provider's first FINAL read must survive that: the resolver keeps it (stored in source_reports),
// and neither the agreement rule nor the foreign-proposal classifier lets a later pending read downgrade it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { classifyForeign } from "../src/core/disputePolicy";
import { agree, type SourceReport } from "../src/core/outcome";
import { questions } from "../src/db/schema";
import { toReport as oddsReport } from "../src/sources/theOddsApi";
import { toReport as sdbReport } from "../src/sources/theSportsDb";
import type { SourceFetchers } from "../src/sources";
import { gatherReports, resolverTick } from "../src/workers/resolver";
import { haveAnvil, havePostgres } from "./helpers/chain";
import { bootResolverEnv, questionOnchain, type ResolverEnv } from "./helpers/resolverHarness";
import { digestOf, eplEvents, expectedFootball, oddsScores } from "./helpers/resolverFixtures";

setDefaultTimeout(120_000);
const DAY = 86400;

describe("L-7: a later pending read never downgrades an earlier final one", () => {
  const t = 1_800_000_000;
  const oddsFinal: SourceReport = { provider: "theoddsapi", fetchedAt: t, status: "final", outcome: 1, digest: "0x01" };
  const oddsGone: SourceReport = { provider: "theoddsapi", fetchedAt: t + 2 * DAY, status: "pending", digest: "0x02" };
  const sdbPending: SourceReport = { provider: "thesportsdb", fetchedAt: t + 2 * DAY, status: "pending", digest: "0x03" };
  const sdbFinal: SourceReport = { provider: "thesportsdb", fetchedAt: t + 2 * DAY, status: "final", outcome: 1, digest: "0x04" };

  test("agree: final then gone still counts as final", () => {
    expect(agree([oddsFinal, oddsGone, sdbFinal]).decision).toBe(1);
  });
  test("classifyForeign: a wrong proposal stays contradicted after the final source forgets the game", () => {
    expect(classifyForeign({ decision: null }, 2, [oddsFinal, oddsGone, sdbPending])).toBe("contradicted");
    expect(classifyForeign({ decision: null }, 1, [oddsFinal, oddsGone, sdbPending])).toBe("unconfirmed");
  });
  test("a later final or void read is a real answer and still wins", () => {
    const corrected: SourceReport = { ...oddsFinal, fetchedAt: t + DAY, outcome: 3 };
    expect(agree([oddsFinal, corrected, { ...sdbFinal, outcome: 3 }]).decision).toBe(3);
    const voided: SourceReport = { provider: "theoddsapi", fetchedAt: t + DAY, status: "void", digest: "0x05" };
    expect(agree([oddsFinal, voided, sdbFinal]).conflict).toBe(true);
  });
});

describe.skipIf(!haveAnvil() || !havePostgres())("L-7 on anvil: The Odds API forgets the game after kickoff + 3 d", () => {
  let env: ResolverEnv;
  beforeAll(async () => {
    env = await bootResolverEnv();
  });
  afterAll(async () => env?.stop());

  test("resolver at +2 d (Odds API final, TheSportsDB late) then +4 d (Odds API gone, TheSportsDB final) proposes the result", async () => {
    const q = await env.question(0);
    const e = eplEvents[0]!;
    const kickoff = q.closeTime;
    const odds = oddsScores.find((s) => s._derivedFrom === e.idEvent)!;
    let clock = 0;
    const sdbLate = { ...e, strStatus: "Not Started", intHomeScore: null, intAwayScore: null };
    // the live endpoint: the event is listed until kickoff + 3 d, then the body is []
    const sources: SourceFetchers = {
      ...env.deps.sources!,
      async oddsScore(_k, _s, id) {
        const body = clock <= kickoff + 3 * DAY ? [odds] : [];
        return oddsReport(body.find((x) => x.id === id), digestOf(body), clock);
      },
      async sportsDbEvent() {
        const ev = clock < kickoff + 4 * DAY ? sdbLate : e;
        return sdbReport(ev, digestOf(ev), clock);
      },
    };
    env.deps.sources = sources;

    clock = kickoff + 2 * DAY;
    await env.chain.warpTo(BigInt(clock));
    await resolverTick(env.deps);
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(1); // one source final only: no proposal yet

    clock = kickoff + 4 * DAY;
    await env.chain.warpTo(BigInt(clock));
    const [row] = await env.pg.db.select().from(questions).where(eq(questions.id, q.id));
    const reads = await gatherReports(env.deps, row!);
    const oddsRead = reads.find((r) => r.provider === "theoddsapi")!;
    expect(oddsRead.status).not.toBe("pending"); // the stored +2 d final, not "event gone"
    expect(oddsRead.status).toBe("final");
    expect(oddsRead.fetchedAt).toBe(kickoff + 2 * DAY);

    await resolverTick(env.deps);
    const o = await questionOnchain(env, q.id);
    expect(Number(o.state)).toBe(2);
    expect(Number(o.proposed)).toBe(expectedFootball(e));
  });
});
