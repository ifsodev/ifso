// todo 11b: the contract refuses a challenge on "touches", so the parser asks instead of offering it.
import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/core/parser";

const ctx = { nowMs: Date.UTC(2026, 10, 2, 12), tickers: new Set(["NVDA", "ETH"]), lastPrice: { NVDA: 180 } };

describe("two-sided TOUCH", () => {
  test("a challenge on 'hits' is not offered: the user gets a question with two real choices", () => {
    const r = parseCommand("/challenge @sam 10 vs 10 if nvda hits 200 by friday", ctx);
    expect(r.ok).toBe(false);
    const q = r.questions.find((x) => x.kind === "touch_challenge");
    expect(q).toBeDefined();
    expect(q!.text).toContain("only check the price at the deadline");
    expect(q!.options.length).toBe(2);
    const [atDeadline, oneSided] = q!.options;
    // option 1 re-parses to a challenge on the price at the deadline
    const a = parseCommand(atDeadline!.text!, ctx);
    expect(a.twoSided).toBe(true);
    expect(a.condition).toMatchObject({ kind: "PRICE", mode: "AT_DEADLINE" });
    expect(a.questions.filter((x) => x.kind === "touch_challenge")).toEqual([]);
    // option 2 re-parses to a one-sided payment that keeps "hits"
    const b = parseCommand(oneSided!.text!, ctx);
    expect(b.twoSided).toBe(false);
    expect(b.errors).toEqual([]);
    expect(b.condition).toMatchObject({ kind: "PRICE", mode: "TOUCH" });
  });
  test("a one-sided payment on 'hits' is unchanged and a challenge at the deadline asks nothing", () => {
    const one = parseCommand("/ifso @sam 10 if nvda hits 200 by friday", ctx);
    expect(one.questions.filter((x) => x.kind === "touch_challenge")).toEqual([]);
    const two = parseCommand("/challenge @sam 10 if nvda closes above 200 by friday", ctx);
    expect(two.questions.filter((x) => x.kind === "touch_challenge")).toEqual([]);
  });
});
