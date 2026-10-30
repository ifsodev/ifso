// R1: replay 50 recorded finished EPL fixtures (TheSportsDB; the Odds API side is synthesized from them and marked
// synthetic) and 20 recorded resolved Polymarket binary questions (Gamma + Polygon CTF payouts) through the real
// parsers and the agreement rule. Clean cases must agree 100% with the independently computed result.
import { describe, expect, test } from "bun:test";
import { agree } from "../src/core/outcome";
import { eplEvents, expectedFootball, expectedPolymarket, fixtureSources, oddsFileIsSynthetic, oddsScores, pmMarkets } from "./helpers/resolverFixtures";

describe("resolver replay on recorded data (R1)", () => {
  test("fixture inventory: 50 fixtures, 50 synthetic odds rows, 20 markets", () => {
    expect(eplEvents.length).toBe(50);
    expect(oddsScores.length).toBe(50);
    expect(oddsFileIsSynthetic).toBe(true);
    expect(pmMarkets.length).toBe(20);
    expect(new Set(eplEvents.map((e) => e.idEvent)).size).toBe(50);
    expect(new Set(pmMarkets.map((m) => m.gamma.conditionId)).size).toBe(20);
  });

  test("50 finished EPL fixtures: both sources final, 100% agreement with the real result", async () => {
    const src = fixtureSources();
    let agreed = 0;
    const seen = new Set<number>();
    for (const e of eplEvents) {
      const odds = oddsScores.find((s) => s._derivedFrom === e.idEvent)!;
      const reports = await Promise.all([src.oddsScore("k", "soccer_epl", odds.id), src.sportsDbEvent("123", e.idEvent)]);
      expect(reports.map((r) => r.status)).toEqual(["final", "final"]);
      const a = agree(reports);
      const want = expectedFootball(e);
      seen.add(want);
      if (a.decision === want) agreed++;
      expect(a.decision).toBe(want);
      expect(a.providers).toEqual(["theoddsapi", "thesportsdb"]);
    }
    expect(agreed).toBe(50);
    expect(seen.size).toBeGreaterThanOrEqual(2); // the sample is not all one result
  });

  test("20 resolved Polymarket questions: Gamma and the on-chain payout agree, 100% with the recorded answer", async () => {
    const src = fixtureSources();
    let agreed = 0;
    const seen = new Set<number>();
    for (const m of pmMarkets) {
      const [g, c] = await Promise.all([src.gamma(m.gamma.slug), src.ctf("rpc", m.gamma.conditionId as `0x${string}`)]);
      expect(g.report.status).toBe("final");
      expect(c.status).toBe("final");
      const a = agree([g.report, c]);
      const want = expectedPolymarket(m.gamma);
      seen.add(want);
      if (a.decision === want) agreed++;
      expect(a.decision).toBe(want);
      expect(a.providers).toEqual(["polygon-ctf", "polymarket-gamma"]);
    }
    expect(agreed).toBe(20);
    expect(seen).toEqual(new Set([1, 2]));
  });

  test("an unresolved or still-open market never produces a decision", async () => {
    const m = pmMarkets[0]!;
    const open = { ...m.gamma, closed: false, umaResolutionStatus: "proposed", outcomePrices: '["0.62", "0.38"]' };
    const src = fixtureSources({ gamma: { [m.gamma.slug]: open }, ctf: { [m.gamma.conditionId]: { den: 0n, yes: 0n, no: 0n } } });
    const [g, c] = await Promise.all([src.gamma(m.gamma.slug), src.ctf("rpc", m.gamma.conditionId as `0x${string}`)]);
    expect([g.report.status, c.status]).toEqual(["pending", "pending"]);
    expect(agree([g.report, c]).decision).toBeNull();
  });
});
