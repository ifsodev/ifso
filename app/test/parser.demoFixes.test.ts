import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/core/parser";

// Found by the demo recordings (2026-11-01). Sat 2026-10-31 10:00 UTC = 14:00 in Dubai (UTC+4), 06:00 in New York.
const SAT = Date.UTC(2026, 9, 31, 10, 0);
const DUBAI = 240;
const tickers = new Set(["NVDA", "TSLA", "AAPL", "SPY", "ETH"]);
const stockTickers = new Set(["NVDA", "TSLA", "AAPL", "SPY"]);
const ctx = (nowMs = SAT, tzOffsetMin = DUBAI) => ({ nowMs, tzOffsetMin, tickers, stockTickers });
const sec = (ms: number) => Math.floor(ms / 1000);

describe("composer parse: demo recording fixes", () => {
  test('"by 3:15am" on a crypto price means the next 3:15 in the user\'s zone, with no market-hours question', () => {
    const r = parseCommand("/ifso link 5 if eth at or above 2000 by 3:15am", ctx());
    expect(r.errors).toEqual([]);
    expect(r.questions).toEqual([]);
    expect(r.ok).toBe(true);
    // next 3:15 in Dubai is Sun 2026-11-01 03:15 +04:00 = Sat 23:15 UTC
    expect(r.condition).toMatchObject({ kind: "PRICE", ticker: "ETH", deadline: sec(Date.UTC(2026, 9, 31, 23, 15)) });
  });

  test('"by 3:15am" as a date means the next 3:15, never a past time', () => {
    const r = parseCommand("/ifso link 5 on by 3:15am", ctx());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.condition).toEqual({ kind: "TIME", at: sec(Date.UTC(2026, 9, 31, 23, 15)) });
  });

  test("a crypto ticker never gets the US market hours question, even on a weekend date", () => {
    for (const when of ["by saturday", "by sunday", "by 3:15am", "by tomorrow", "by 9pm"]) {
      const r = parseCommand(`/ifso link 5 if eth at or above 2000 ${when}`, ctx());
      expect(r.questions.map((q) => q.kind)).not.toContain("weekend");
      expect(r.errors).toEqual([]);
    }
  });

  test("a stock ticker still gets it, and every answer rebuilds a valid command", () => {
    const thu = Date.UTC(2026, 9, 29, 14, 0);
    const days = [thu, Date.UTC(2026, 9, 30, 23, 0), SAT, Date.UTC(2026, 10, 1, 2, 0)];
    let asked = 0;
    for (const now of days)
      for (const when of ["by saturday", "by sunday", "by 3:15am", "by 9pm", "by saturday 3pm", "by next sunday"]) {
        const text = `/ifso link 5 if nvda at or above 200 ${when}`;
        const r = parseCommand(text, ctx(now));
        expect(r.errors).toEqual([]);
        if (r.condition && "deadline" in r.condition) expect(r.condition.deadline * 1000).toBeGreaterThan(now);
        for (const q of r.questions)
          for (const o of q.options) {
            asked++;
            expect(o.text).toMatch(/^\/ifso link 5 if nvda /);
            const again = parseCommand(o.text!, ctx(now));
            expect(again.errors).toEqual([]);
            expect(again.ok).toBe(true);
          }
      }
    expect(asked).toBeGreaterThan(0);
  });

  test('"in 10 minutes", "in 2 hours" and "in 3 days" work without "by"', () => {
    const p = parseCommand("/ifso link 5 if eth at or above 2000 in 10 minutes", ctx());
    expect(p.errors).toEqual([]);
    expect(p.ok).toBe(true);
    expect(p.condition).toMatchObject({ kind: "PRICE", deadline: sec(SAT) + 600 });
    expect(parseCommand("/ifso link 5 if eth hits 2500 in 2 hours", ctx()).condition).toMatchObject({ mode: "TOUCH", deadline: sec(SAT) + 7200 });
    expect(parseCommand("/ifso link 5 in 3 days", ctx()).condition).toEqual({ kind: "TIME", at: sec(SAT) + 3 * 86400 });
    expect(parseCommand("/ifso link 5 in 10 minutes", ctx()).ok).toBe(true);
  });

  test("a time too soon for the contract says so in plain words", () => {
    const t = parseCommand("/ifso link 5 in 1 minute", ctx());
    expect(t.ok).toBe(false);
    expect(t.errors.join(" ")).toContain("too soon");
    // a price challenge must stay open for acceptance for a while before the deciding price can be known
    const c = parseCommand("/challenge 0x00000000000000000000000000000000000000aa 5 if @ref_x says so", ctx());
    expect(c.ok).toBe(true);
    const pc = parseCommand("/challenge 0x00000000000000000000000000000000000000aa 5 if eth is at or above 2000 in 30 minutes", ctx());
    expect(pc.ok).toBe(false);
    expect(pc.errors.join(" ")).toContain("too soon");
    expect(parseCommand("/challenge 0x00000000000000000000000000000000000000aa 5 if eth is at or above 2000 in 2 hours", ctx()).ok).toBe(true);
  });
});
