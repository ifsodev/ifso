import { describe, expect, test } from "bun:test";
import { copy } from "../src/core/copy";
import { parseCommand, parseWhen } from "../src/core/parser";

// Wed 2026-10-21 12:00 UTC (08:00 New York, EDT)
const NOW = Date.UTC(2026, 9, 21, 12, 0);
const ctx = { nowMs: NOW, tickers: new Set(["NVDA", "TSLA", "AAPL", "SPY", "ETH"]) };
const iso = (unix: number) => new Date(unix * 1000).toISOString();

describe("parser: heads", () => {
  test("canonical sports example", () => {
    const r = parseCommand("/ifso @jake 20 if arsenal win", ctx);
    expect(r.ok).toBe(true);
    expect(r.twoSided).toBe(false);
    expect(r.recipient).toEqual({ type: "handle", handle: "jake" });
    expect(r.amountUsdg).toBe("20");
    expect(r.condition).toEqual({ kind: "SPORTS", team: "arsenal", opponent: undefined, result: "WIN", on: undefined });
    expect(r.preview).toContain("Send 20 USDG to @jake");
    expect(r.preview).toContain("comes back to you");
  });

  test("bot username suffix, $ and decimals, address recipient", () => {
    const r = parseCommand("/ifso@IfsoBot 0x00000000000000000000000000000000000000aa $12.50 usdg if arsenal beat chelsea", ctx);
    expect(r.ok).toBe(true);
    expect(r.recipient).toEqual({ type: "address", address: "0x00000000000000000000000000000000000000aa" });
    expect(r.amountUsdg).toBe("12.5");
    expect(r.condition).toMatchObject({ kind: "SPORTS", team: "arsenal", opponent: "chelsea", result: "WIN" });
  });

  test("garbage gives usage", () => {
    const r = parseCommand("/ifso hello", ctx);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("Try:");
  });

  test("bot examples are Polymarket / price / date / referee, never football (DECISIONS #44: football OFF at launch)", () => {
    const shown = [copy.parse.usage, copy.bot.help, copy.bot.wrongBot, copy.oneLiner].join(" ");
    expect(shown).not.toMatch(/arsenal|match result/i);
    const examples = copy.parse.usage.replace(/^Try: /, "").split(" · ");
    for (const ex of examples) expect(parseCommand(ex, ctx).condition?.kind).not.toBe("SPORTS");
    // the Polymarket example carries the placeholder slug (test/copyExamples.test.ts); with a real slug in its place it is a market
    const real = (ex: string) => ex.replace("the-market-slug", "some-open-market");
    expect(parseCommand(real(examples[0]!), ctx).condition).toMatchObject({ kind: "MARKET", venue: "polymarket", answer: "YES" });
    expect(parseCommand(real(copy.bot.wrongBot.replace(/^.*like /, "").replace(/\.$/, "")), ctx).condition?.kind).toBe("MARKET");
  });

  test("minimum amount", () => {
    expect(parseCommand("/ifso @a_b 0.5 if arsenal win", ctx).errors.length).toBeGreaterThan(0);
  });
});

describe("parser: TIME", () => {
  test("on the 1st -> next month 09:00 in user tz", () => {
    const r = parseCommand("/ifso link 1200 on the 1st", { ...ctx, tzOffsetMin: 240 }); // Dubai
    expect(r.ok).toBe(true);
    expect(r.recipient).toEqual({ type: "link" });
    expect(r.condition?.kind).toBe("TIME");
    expect(iso((r.condition as { at: number }).at)).toBe("2026-11-01T05:00:00.000Z"); // 09:00 Dubai
  });

  test("the preview of a date condition reads once: 'It unlocks if <date> has arrived', never 'unlocks if it unlocks on'", () => {
    const r = parseCommand("/ifso @mia 5 in 3 days", ctx);
    const preview = r.preview ?? "";
    expect(preview).toMatch(/It unlocks if .+ has arrived\./);
    expect(preview).not.toMatch(/unlocks if it unlocks/i);
    expect(preview.match(/unlocks/gi)).toHaveLength(1);
  });

  test("in 3 days", () => {
    const r = parseCommand("/ifso @mia 5 in 3 days", ctx);
    expect((r.condition as { at: number }).at).toBe(NOW / 1000 + 3 * 86400);
  });

  test("month-day with explicit time", () => {
    const r = parseCommand("/ifso @mia 5 on nov 14 at 6pm", ctx);
    expect(iso((r.condition as { at: number }).at)).toBe("2026-11-14T18:00:00.000Z");
  });

  test("ambiguous numeric date is never guessed", () => {
    const r = parseCommand("/ifso @mia 5 on 11/01", ctx);
    expect(r.ok).toBe(false);
    expect(r.ambiguities.join(" ") + r.errors.join(" ")).toMatch(/day\/month|couldn't read/);
  });

  test("past dates rejected", () => {
    const r = parseCommand("/ifso @mia 5 on 2026-01-01", ctx);
    expect(r.ok).toBe(false);
  });
});

describe("parser: PRICE", () => {
  test("closes above by friday -> AT_DEADLINE at 16:00 New York", () => {
    const r = parseCommand("/ifso @mia 100 if nvda closes above 200 by friday", ctx);
    expect(r.ok).toBe(true);
    expect(r.condition).toMatchObject({ kind: "PRICE", ticker: "NVDA", op: "GTE", priceUsd: "200", mode: "AT_DEADLINE" });
    expect(iso((r.condition as { deadline: number }).deadline)).toBe("2026-10-23T20:00:00.000Z"); // 16:00 EDT
  });

  test("hits -> TOUCH, deadline 20:00 New York; direction needs context", () => {
    const amb = parseCommand("/ifso @mia 100 if tsla hits 300 by friday", ctx);
    expect(amb.ok).toBe(false);
    expect(amb.ambiguities[0]).toContain("at or above");
    const r = parseCommand("/ifso @mia 100 if tsla hits 300 by friday", { ...ctx, lastPrice: { TSLA: 250 } });
    expect(r.ok).toBe(true);
    expect(r.condition).toMatchObject({ mode: "TOUCH", op: "GTE" });
    expect(iso((r.condition as { deadline: number }).deadline)).toBe("2026-10-24T00:00:00.000Z"); // 20:00 EDT
  });

  test("below / under -> LTE; missing deadline asks", () => {
    const r = parseCommand("/ifso @mia 100 if spy is below 500", ctx);
    expect(r.ok).toBe(false);
    expect(r.ambiguities).toContain("By when? Add something like \"by friday\" or \"on nov 14\".");
    expect(r.condition).toMatchObject({ op: "LTE" });
  });

  test("weekend deadline rolls to Friday close; DST boundary handled (EST in December)", () => {
    const r = parseCommand("/ifso @mia 100 if nvda closes above 200 on dec 12", ctx); // Saturday
    expect(iso((r.condition as { deadline: number }).deadline)).toBe("2026-12-11T21:00:00.000Z"); // Fri 16:00 EST
    expect(r.notes.join(" ")).toContain("Friday");
  });

  test("unknown ticker", () => {
    const r = parseCommand("/ifso @mia 100 if zzzz above 10 by friday", ctx);
    expect(r.errors[0]).toContain("ZZZZ");
  });
});

describe("parser: APPROVE / MARKET / challenges", () => {
  test("both tap OK", () => {
    expect(parseCommand("/ifso @sam 300 when we both say ok", ctx).condition).toEqual({ kind: "APPROVE", mode: "PARTIES" });
  });

  test("referee", () => {
    expect(parseCommand("/ifso @sam 300 if @ref_guy says so", ctx).condition).toEqual({
      kind: "APPROVE",
      mode: "REFEREE",
      referee: { type: "handle", handle: "ref_guy" },
    });
  });

  test("polymarket url", () => {
    const r = parseCommand("/ifso @sam 10 if https://polymarket.com/event/fed-cut-december resolves yes", ctx);
    expect(r.condition).toEqual({ kind: "MARKET", venue: "polymarket", ref: "https://polymarket.com/event/fed-cut-december", answer: "YES" });
  });

  test("challenge with two amounts and referee", () => {
    const r = parseCommand("/challenge @sam 10 vs 15 if @ref_guy decides", ctx);
    expect(r.ok).toBe(true);
    expect(r.twoSided).toBe(true);
    expect(r.counterAmountUsdg).toBe("15");
    expect(r.preview).toContain("you chip in 10 USDG, they chip in 15 USDG");
  });

  test("challenge cannot be time-based or honor-system", () => {
    expect(parseCommand("/challenge @sam 10 on friday", ctx).ok).toBe(false);
    expect(parseCommand("/challenge @sam 10 when we both say ok", ctx).ok).toBe(false);
  });

  test("second amount only for challenges", () => {
    expect(parseCommand("/ifso @sam 10 vs 15 if arsenal win", ctx).ok).toBe(false);
  });

  test("sports with trailing day is a date, not an opponent", () => {
    const r = parseCommand("/ifso @jake 20 if arsenal win saturday", ctx);
    expect(r.condition).toMatchObject({ kind: "SPORTS", team: "arsenal", opponent: undefined });
    expect((r.condition as { on?: number }).on).toBeGreaterThan(NOW / 1000);
  });

  test("win or draw", () => {
    expect(parseCommand("/ifso @jake 20 if man united don't lose", ctx).condition).toMatchObject({ team: "man united", result: "WIN_OR_DRAW" });
  });
});

describe("parseWhen edge cases", () => {
  test("same weekday later today stays today; already passed rolls a week", () => {
    const res = { ambiguities: [] as string[], notes: [] as string[] };
    expect(iso(parseWhen("wednesday 5pm", NOW, 0, 9, res)!)).toBe("2026-10-21T17:00:00.000Z");
    expect(iso(parseWhen("wednesday 9am", NOW, 0, 9, res)!)).toBe("2026-10-28T09:00:00.000Z");
  });
  test("next friday skips this week's", () => {
    const res = { ambiguities: [] as string[], notes: [] as string[] };
    expect(iso(parseWhen("next friday", NOW, 0, 9, res)!)).toBe("2026-10-30T09:00:00.000Z");
  });
});
