// Testnet run 2026-11-01: a TOUCH payment whose level was never reached (deadline 00:07:31, expiry deadline + 6 h) raised
// "keeper-lag: escrows decidable for over 10 minutes and not settled" at 00:17:50 and again every 30 minutes. It is not
// decidable: after its deadline an untouched TOUCH can only come back at expiry (refund sweep), so the keeper is right
// to leave it. On mainnet (expiry = deadline + 1 day) every untouched TOUCH would page the team for a whole day.
import { describe, expect, test } from "bun:test";
import { keeperShouldHaveSettled } from "../src/ops/monitors";
import { Kind, PRICE_AT_DEADLINE, PRICE_TOUCH } from "../src/core/types";

describe("keeper-lag only counts escrows the keeper can actually settle", () => {
  test("an untouched TOUCH after its deadline is waiting for expiry, not lagging", () => {
    expect(keeperShouldHaveSettled({ kind: Kind.PRICE, condition: { kind: Kind.PRICE, mode: PRICE_TOUCH } })).toBe(false);
  });
  test("a price at the deadline, a TIME payment and an outcome still count", () => {
    expect(keeperShouldHaveSettled({ kind: Kind.PRICE, condition: { kind: Kind.PRICE, mode: PRICE_AT_DEADLINE } })).toBe(true);
    expect(keeperShouldHaveSettled({ kind: Kind.TIME, condition: { kind: Kind.TIME, mode: 0 } })).toBe(true);
    expect(keeperShouldHaveSettled({ kind: Kind.OUTCOME, condition: { kind: Kind.OUTCOME, mode: 0 } })).toBe(true);
  });
  test("mode stored as a string (jsonb round trip) is read the same", () => {
    expect(keeperShouldHaveSettled({ kind: Kind.PRICE, condition: { mode: String(PRICE_TOUCH) } })).toBe(false);
  });
});
