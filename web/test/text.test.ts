import { describe, expect, test } from "vitest";
import { parseCommand } from "../../app/src/core/parser";
import { SEED_FEEDS } from "../../app/src/config/chain";
import { commandText, isAddressLike } from "@/lib/ifso/text";

const tickers = new Set(SEED_FEEDS.map((f) => f.ticker));
const parse = (text: string) => parseCommand(text, { nowMs: Date.parse("2026-11-20T12:00:00Z"), tickers });
const A = "0x1234567890abcdef1234567890abcdef12345678";

describe("composer fields become a command the service's parser accepts", () => {
  test("date", () => {
    const t = commandText({ kind: "date", amount: "20", recipient: "", detail: "dec 1" });
    expect(t).toBe("/ifso link 20 on dec 1");
    expect(parse(t)).toMatchObject({ ok: true, twoSided: false, recipient: { type: "link" }, condition: { kind: "TIME" } });
  });
  test("a typed connective is kept", () => {
    expect(commandText({ kind: "date", amount: "20", recipient: "", detail: "in 3 days" })).toBe("/ifso link 20 in 3 days");
  });
  test("named recipient, match, referee and approval", () => {
    expect(parse(commandText({ kind: "match", amount: "20", recipient: A, detail: "arsenal win" }))).toMatchObject({ recipient: { type: "address" }, condition: { kind: "SPORTS" } });
    expect(parse(commandText({ kind: "referee", amount: "20", recipient: A, detail: `${A} decides` })).condition).toMatchObject({ kind: "APPROVE", mode: "REFEREE" });
    expect(parse(commandText({ kind: "approval", amount: "20", recipient: A, detail: "we both approve" })).condition).toMatchObject({ kind: "APPROVE", mode: "PARTIES" });
  });
  test("a price without a direction asks, it does not guess", () => {
    const r = parse(commandText({ kind: "price", amount: "20", recipient: "", detail: "eth hits 4000 by friday" }));
    expect(r.questions.length + r.ambiguities.length).toBeGreaterThan(0);
  });
  test("challenge uses the two-amount form", () => {
    const t = commandText({ kind: "match", amount: "20", recipient: A, detail: "arsenal win", challenge: true, counter: "25" });
    expect(t).toBe(`/challenge ${A} 20 vs 25 if arsenal win`);
    expect(parse(t)).toMatchObject({ twoSided: true, counterAmountUsdg: "25" });
  });
  test("address check", () => {
    expect(isAddressLike(A)).toBe(true);
    expect(isAddressLike("@jake")).toBe(false);
  });
});
