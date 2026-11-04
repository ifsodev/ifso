// Audit M-2 regression (PoC LW-1, inverted): a football question planned while the TheSportsDB lookup failed had ONE
// source forever. Every foreign proposal on it was "unconfirmed": never disputed early even when the one source
// contradicted it, and always disputed at last call (bond lost when it was honest) until the float hit the reserve.
// Now: (1) a football question without a second-source id is refused at planning and at registration; (2) a final
// source that contradicts a proposal, with no final source backing it, makes the proposal "contradicted" (disputed at
// once); (3) the round-3 last-call slot and one-bond reserve are unchanged for proposals that stay unconfirmed.
import { afterAll, describe, expect, test } from "bun:test";
import { findFixture } from "../src/api/fixtures";
import { loadEnv } from "../src/config/env";
import { agree } from "../src/core/outcome";
import { classifyForeign, planForeignDisputes } from "../src/core/disputePolicy";
import { FOOTBALL_ONE_SOURCE, FootballRefused, footballRow, gatherReports, planFootballQuestion, registerPlanned } from "../src/workers/resolver";
import type { Deps } from "../src/workers/deps";

const realFetch = globalThis.fetch;
afterAll(() => (globalThis.fetch = realFetch));

const KICK = Math.floor(Date.now() / 1000) + 86400;
const ev = { id: "evt1", sport_key: "soccer_epl", commence_time: new Date(KICK * 1000).toISOString(), home_team: "Brighton and Hove Albion", away_team: "Arsenal" };

describe("audit M-2: one-source football questions", () => {
  test("SportsDB lookup failure -> the fixture is refused, never planned as a one-source question", async () => {
    // network stub: Odds API lists the fixture; TheSportsDB search is rate limited (429)
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes("the-odds-api.com") && u.includes("/events")) return new Response(JSON.stringify(u.includes("soccer_epl") ? [ev] : []), { status: 200 });
      if (u.includes("thesportsdb.com")) return new Response("rate limited", { status: 429 });
      return new Response("[]", { status: 200 });
    }) as never;
    const env = loadEnv({ ODDS_API_KEY: "k" });
    let inserts = 0;
    const deps = { env, db: { select: () => { throw new Error("must refuse before any DB read"); }, insert: () => (inserts++, { values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) }) } } as unknown as Deps;
    const fx = await findFixture(deps, "arsenal");
    expect(fx.fixture?.sportsDbEventId).toBeUndefined();
    let err: unknown;
    await planFootballQuestion(deps, fx.fixture!).catch((e) => (err = e));
    expect(err).toBeInstanceOf(FootballRefused);
    expect((err as Error).message).toBe(FOOTBALL_ONE_SOURCE);
    expect(inserts).toBe(0);
    // with the second source switched off the same holds even for a fixture that has an id
    const off = { ...deps, env: loadEnv({ ODDS_API_KEY: "k", SECOND_SPORTS_SOURCE: "none" }) } as unknown as Deps;
    await expect(planFootballQuestion(off, { ...fx.fixture!, sportsDbEventId: "123" })).rejects.toBeInstanceOf(FootballRefused);
  });

  test("a one-source row planned before the fix is never registered on the resolver", async () => {
    const fixture = { sportKey: "soccer_epl", oddsApiEventId: "evt1", home: ev.home_team, away: ev.away_team, commenceTime: KICK };
    const { row } = footballRow(fixture);
    const deps = { env: loadEnv({}), db: { select: () => ({ from: () => ({ where: async () => [{ ...row, state: 0 }] }) }) }, clients: {} } as unknown as Deps;
    await expect(registerPlanned(deps, row.id as never)).rejects.toBeInstanceOf(FootballRefused);
  });

  test("one final source contradicting a foreign proposal -> contradicted (disputed at once); backing it -> unconfirmed", async () => {
    const env = loadEnv({ ODDS_API_KEY: "k" });
    const fixture = { sportKey: "soccer_epl", oddsApiEventId: "evt1", sportsDbEventId: "999", home: ev.home_team, away: ev.away_team, commenceTime: KICK };
    const { row } = footballRow(fixture);
    // the Odds API is final (HOME=1); TheSportsDB is not readable this tick
    const deps = {
      env,
      db: { insert: () => ({ values: async () => {} }), select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }) }, // no stored finals (audit L-7)
      sources: {
        oddsScore: async () => ({ provider: "theoddsapi", fetchedAt: KICK + 9000, status: "final", outcome: 1, digest: "0x01" }),
        sportsDbEvent: async () => { throw new Error("429"); },
        gamma: async () => { throw new Error("n/a"); },
        ctf: async () => { throw new Error("n/a"); },
      },
    } as unknown as Deps;
    const reports = await gatherReports(deps, { ...row, state: 2 } as never);
    expect(reports.length).toBe(2);
    const a = agree(reports);
    expect(a.decision).toBeNull();
    expect(classifyForeign(a, 1, reports)).toBe("unconfirmed"); // honest: the final source backs it, no early dispute
    expect(classifyForeign(a, 2, reports)).toBe("contradicted"); // wrong: disputed at once, not left to the reserve
    // two final sources that split: the side one of them backs is never "contradicted" (the panel decides)
    const split = [...reports.filter((r) => r.provider === "theoddsapi"), { provider: "thesportsdb", fetchedAt: KICK + 9000, status: "final" as const, outcome: 2, digest: "0x02" as const }];
    expect(classifyForeign(agree(split), 1, split)).toBe("unconfirmed");
    expect(classifyForeign(agree(split), 3, split)).toBe("contradicted");

    const bond = 100_000_000n;
    const now = 1_000_000;
    // a wrong proposal is disputed even when only the last bond is left (contradicted may use it)
    const wrong = planForeignDisputes({ now, lastCall: 1200, bond, balance: 100_000_000n, openLastCall: 0, candidates: [{ id: "0xbad", verdict: classifyForeign(a, 2, reports), closesAt: now + 7000, atRisk: 50_000_000_000n }] });
    expect(wrong[0]).toEqual({ id: "0xbad", do: "dispute", kind: "contradicted" });
    // round-3 protections unchanged for unconfirmed proposals: wait before the slot, keep one bond in the slot
    const cands = Array.from({ length: 5 }, (_, i) => ({ id: `0x${i}`, verdict: "unconfirmed" as const, closesAt: now + 600, atRisk: 1_000_000n }));
    expect(planForeignDisputes({ now, lastCall: 1200, bond, balance: 500_000_000n, openLastCall: 0, candidates: cands }).filter((x) => x.do === "dispute").length).toBe(4);
    expect(planForeignDisputes({ now: now - 5000, lastCall: 1200, bond, balance: 500_000_000n, openLastCall: 0, candidates: cands }).every((x) => x.do === "wait")).toBe(true);
  });
});
