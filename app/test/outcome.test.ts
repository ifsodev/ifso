import { describe, expect, test } from "bun:test";
import { keccak256, toHex } from "viem";
import { agree, canonicalEvidence, binaryMask, footballOutcome, hip4Outcome, polymarketOutcome, questionSpecHash, sourcesHash, sportsMask, type SourceReport } from "../src/core/outcome";
import { toReport as oddsReport } from "../src/sources/theOddsApi";
import { toReport as sdbReport } from "../src/sources/theSportsDb";

const rep = (provider: string, status: SourceReport["status"], outcome?: number, t = 1000): SourceReport => ({ provider, fetchedAt: t, status, outcome, digest: "0x01" });

describe("multi-source agreement", () => {
  test("needs two independent sources", () => {
    expect(agree([rep("a", "final", 1)]).decision).toBeNull();
    expect(agree([rep("a", "final", 1), rep("a", "final", 1, 2000)]).decision).toBeNull(); // same provider twice
  });
  test("two agreeing finals propose", () => {
    const a = agree([rep("theoddsapi", "final", 1), rep("thesportsdb", "final", 1)]);
    expect(a.decision).toBe(1);
    expect(a.providers).toEqual(["theoddsapi", "thesportsdb"]);
  });
  test("disagreement holds (never proposes)", () => {
    expect(agree([rep("a", "final", 1), rep("b", "final", 3)]).decision).toBeNull();
    expect(agree([rep("a", "final", 1), rep("b", "void")]).decision).toBeNull();
  });
  test("both void => VOID (0)", () => {
    expect(agree([rep("a", "void"), rep("b", "void")]).decision).toBe(0);
  });
  test("latest report per provider wins", () => {
    expect(agree([rep("a", "pending", undefined, 1), rep("a", "final", 2, 5), rep("b", "final", 2)]).decision).toBe(2);
  });
  test("sourcesHash is order-independent", () => {
    const x = [rep("b", "final", 1), rep("a", "final", 1)];
    expect(sourcesHash(x)).toBe(sourcesHash([...x].reverse()));
  });
});

describe("sourcesHash is deterministic (R6)", () => {
  const evidence = (): SourceReport[] => [
    { provider: "thesportsdb", fetchedAt: 1_800_000_100, status: "final", outcome: 1, digest: "0xaa" },
    { provider: "theoddsapi", fetchedAt: 1_800_000_050, status: "final", outcome: 1, digest: "0xbb" },
  ];
  test("same evidence gives the same hash, however it is built or ordered", () => {
    const h = sourcesHash(evidence());
    expect(sourcesHash(evidence())).toBe(h);
    expect(sourcesHash([...evidence()].reverse())).toBe(h);
    expect(sourcesHash(evidence().map((r) => ({ digest: r.digest, outcome: r.outcome, status: r.status, fetchedAt: r.fetchedAt, provider: r.provider })))).toBe(h); // key order
    expect(agree(evidence()).sourcesHash).toBe(h);
    expect(agree([...evidence()].reverse()).sourcesHash).toBe(h);
  });
  test("it is the keccak of one fixed canonical form", () => {
    expect(canonicalEvidence(evidence())).toBe('[{"p":"theoddsapi","t":1800000050,"s":"final","o":1,"d":"0xbb"},{"p":"thesportsdb","t":1800000100,"s":"final","o":1,"d":"0xaa"}]');
    expect(sourcesHash(evidence())).toBe(keccak256(toHex(canonicalEvidence(evidence()))));
  });
  test("any change in the evidence changes the hash", () => {
    const h = sourcesHash(evidence());
    for (const mutate of [
      (r: SourceReport[]) => (r[0]!.digest = "0xcc"),
      (r: SourceReport[]) => (r[0]!.outcome = 2),
      (r: SourceReport[]) => (r[1]!.fetchedAt += 1),
      (r: SourceReport[]) => (r[1]!.status = "void"),
      (r: SourceReport[]) => (r[1]!.provider = "other"),
    ]) {
      const r = evidence();
      mutate(r);
      expect(sourcesHash(r)).not.toBe(h);
    }
  });
  test("a contradiction is flagged as a conflict, a missing source is not", () => {
    expect(agree([rep("a", "final", 1), rep("b", "final", 2)]).conflict).toBe(true);
    expect(agree([rep("a", "final", 1), rep("b", "void")]).conflict).toBe(true);
    expect(agree([rep("a", "final", 1), rep("b", "pending")]).conflict).toBeUndefined();
    expect(agree([rep("a", "final", 1)]).conflict).toBeUndefined();
  });
});

describe("outcome mapping", () => {
  test("football 1X2", () => {
    expect(footballOutcome(2, 1)).toBe(1);
    expect(footballOutcome(0, 3)).toBe(2);
    expect(footballOutcome(1, 1)).toBe(3);
  });
  test("masks", () => {
    expect(sportsMask(true, "WIN")).toBe(2n);
    expect(sportsMask(false, "WIN")).toBe(4n);
    expect(sportsMask(true, "WIN_OR_DRAW")).toBe(10n);
    expect(sportsMask(true, "LOSE")).toBe(4n);
    expect(sportsMask(false, "DRAW")).toBe(8n);
    expect(binaryMask("YES")).toBe(2n);
    expect(binaryMask("NO")).toBe(4n);
    for (const m of [sportsMask(true, "WIN"), sportsMask(false, "WIN_OR_DRAW"), binaryMask("NO")]) expect(m & 1n).toBe(0n); // VOID never "met"
  });
  test("polymarket and HIP-4", () => {
    expect(polymarketOutcome(true, true, ["1", "0"])).toBe(1);
    expect(polymarketOutcome(true, true, ["0", "1"])).toBe(2);
    expect(polymarketOutcome(true, true, ["0.5", "0.5"])).toBe(0);
    expect(polymarketOutcome(true, false, ["1", "0"])).toBeNull();
    expect(hip4Outcome("1.0")).toBe(1);
    expect(hip4Outcome("0.0")).toBe(2);
    expect(hip4Outcome("0.37")).toBe(0);
    expect(hip4Outcome(null)).toBeNull();
  });
  test("spec hash canonical (key order independent)", () => {
    expect(questionSpecHash({ a: 1, b: { y: 2, x: 1 } })).toBe(questionSpecHash({ b: { x: 1, y: 2 }, a: 1 }));
  });
});

describe("provider adapters (pure parts)", () => {
  test("The Odds API scores", () => {
    const e = { id: "e1", sport_key: "soccer_epl", commence_time: "", completed: true, home_team: "Arsenal", away_team: "Chelsea", scores: [{ name: "Arsenal", score: "2" }, { name: "Chelsea", score: "2" }], last_update: null };
    expect(oddsReport(e, "0x01", 1)).toMatchObject({ status: "final", outcome: 3 });
    expect(oddsReport({ ...e, completed: false }, "0x01", 1).status).toBe("pending");
    expect(oddsReport(undefined, "0x01", 1).status).toBe("pending");
  });
  test("TheSportsDB statuses", () => {
    const base = { idEvent: "1", strHomeTeam: "Arsenal", strAwayTeam: "Chelsea" };
    expect(sdbReport({ ...base, strStatus: "Match Finished", intHomeScore: "3", intAwayScore: "1" }, "0x01", 1)).toMatchObject({ status: "final", outcome: 1 });
    expect(sdbReport({ ...base, strStatus: "Postponed", intHomeScore: null, intAwayScore: null }, "0x01", 1).status).toBe("void");
    expect(sdbReport({ ...base, strStatus: "2H", intHomeScore: "1", intAwayScore: "0" }, "0x01", 1).status).toBe("pending");
  });
});
