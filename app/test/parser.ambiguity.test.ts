// R2: every kind of ambiguity becomes a question with buttons, never a guessed preview, and each button's
// text resolves exactly that question.
import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/core/parser";
import { buttonsOf, makeHarness, textOf } from "./helpers/botHarness";

const NOW = Date.UTC(2026, 9, 21, 12, 0);
const ctx = { nowMs: NOW, tickers: new Set(["NVDA", "TSLA", "AAPL", "SPY", "ETH"]) };

const CASES: { kind: string; input: string; options: number; pick: number; then: (r: ReturnType<typeof parseCommand>) => void }[] = [
  {
    kind: "direction",
    input: "/ifso @mia 100 if tsla hits 300 by friday",
    options: 2,
    pick: 1,
    then: (r) => expect(r.condition).toMatchObject({ kind: "PRICE", ticker: "TSLA", op: "LTE", mode: "TOUCH" }),
  },
  {
    kind: "deadline",
    input: "/ifso @mia 100 if nvda closes above 200",
    options: 3,
    pick: 1,
    then: (r) => expect(new Date((r.condition as { deadline: number }).deadline * 1000).toISOString()).toBe("2026-10-23T20:00:00.000Z"),
  },
  {
    kind: "date_format",
    input: "/ifso @mia 5 on 11/01",
    options: 2,
    pick: 0,
    then: (r) => expect(new Date((r.condition as { at: number }).at * 1000).toISOString()).toBe("2027-01-11T09:00:00.000Z"), // 11 Jan (day first)
  },
  {
    kind: "date_format",
    input: "/ifso @mia 5 on 11/01",
    options: 2,
    pick: 1,
    then: (r) => expect(new Date((r.condition as { at: number }).at * 1000).toISOString()).toBe("2026-11-01T09:00:00.000Z"), // Nov 1 (month first)
  },
  {
    kind: "weekend",
    input: "/ifso @mia 100 if nvda closes above 200 on dec 12", // a Saturday
    options: 2,
    pick: 1,
    then: (r) => expect(new Date((r.condition as { deadline: number }).deadline * 1000).toISOString()).toBe("2026-12-14T21:00:00.000Z"), // Monday 16:00 EST
  },
  {
    kind: "weekend",
    input: "/ifso @mia 100 if nvda closes above 200 on dec 12",
    options: 2,
    pick: 0,
    then: (r) => expect(new Date((r.condition as { deadline: number }).deadline * 1000).toISOString()).toBe("2026-12-11T21:00:00.000Z"), // Friday
  },
];

describe("parser ambiguity (R2)", () => {
  for (const c of CASES) {
    test(`${c.kind}: "${c.input}" asks, option ${c.pick} resolves it`, () => {
      const r = parseCommand(c.input, ctx);
      expect(r.ok).toBe(false);
      expect(r.questions[0]!.kind as string).toBe(c.kind);
      expect(r.questions[0]!.options.length).toBe(c.options);
      expect(r.ambiguities.length).toBe(r.questions.length);
      const next = parseCommand(r.questions[0]!.options[c.pick]!.text!, ctx);
      expect(next.errors).toEqual([]);
      expect(next.questions.filter((q) => q.kind === c.kind)).toEqual([]);
      c.then(next);
    });
  }

  test("unambiguous numeric dates are read without asking (day above 12, or both parts equal)", () => {
    expect(parseCommand("/ifso @mia 5 on 25/12", ctx).ok).toBe(true);
    expect(parseCommand("/ifso @mia 5 on 12/25", ctx).ok).toBe(true);
    expect(parseCommand("/ifso @mia 5 on 05/05", ctx).ok).toBe(true);
  });

  test("an ambiguous draft is never marked ok and never gets a usable preview of a guess", () => {
    for (const c of CASES) expect(parseCommand(c.input, ctx).ok).toBe(false);
  });

  test("two missing pieces are asked one at a time", async () => {
    const h = makeHarness();
    const first = await h.say("/ifso @mia 100 if tsla hits 300");
    expect(buttonsOf(first).length).toBe(2); // direction first
    const second = await h.press(buttonsOf(first)[0].callback_data);
    expect(textOf(second)).toContain("By when?");
    expect(buttonsOf(second).length).toBe(3);
    const done = await h.press(buttonsOf(second)[1].callback_data);
    expect(buttonsOf(done)).toHaveLength(1);
    expect(buttonsOf(done)[0].url).toMatch(/^https:\/\/ifso\.test\/new\/[0-9a-f-]{36}$/);
    expect(textOf(done)).toContain("TSLA reaches at or above $300 at any point before");
    expect(h.store.intents.size).toBe(1); // one intent row, updated in place
  });

  test("a team that matches two clubs becomes a question showing league and kickoff", async () => {
    const h = makeHarness();
    const out = await h.say("/ifso @sam 10 if manchester win");
    const b = buttonsOf(out);
    expect(b.length).toBe(2);
    expect(b[0].text).toContain("Manchester City · Premier League · 2026-10-24");
    expect(b[1].text).toContain("Manchester United");
    const done = await h.press(b[1].callback_data);
    expect(textOf(done)).toContain("manchester united win");
    expect(buttonsOf(done)[0].url).toContain("/new/");
  });

  test("only the person who asked can answer, and answers expire with the intent", async () => {
    const h = makeHarness();
    const out = await h.say("/ifso @mia 5 on 11/01", { userId: 7 });
    const data = buttonsOf(out)[0].callback_data as string;
    const other = await h.press(data, { userId: 8 });
    expect(other.find((x) => x.method === "answerCallbackQuery")!.payload.text).toContain("belong to someone else");
    expect(buttonsOf(other)).toEqual([]);
    const [it] = [...h.store.intents.values()];
    it!.expiresAt = new Date(NOW - 1);
    const late = await h.press(data, { userId: 7 });
    expect(late.find((x) => x.method === "answerCallbackQuery")!.payload.text).toContain("timed out");
  });
});
