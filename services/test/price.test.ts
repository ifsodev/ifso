// Mirrors contracts/test/PriceConditions.t.sol scenarios: the keeper's off-chain decision must match the
// contract's, otherwise it would send settle() txs that revert or skip decidable ones.
import { describe, expect, test } from "bun:test";
import { evaluatePrice, isRegularSession, nyOffsetHours, nyWallClockToUnix, type Round } from "../src/core/price";
import { Kind, OP_GTE, OP_LTE, PRICE_AT_DEADLINE, PRICE_TOUCH, Verdict, emptyCondition, type Condition } from "../src/core/types";

const DL = 1_790_259_200n; // deadline
const TOKEN = "0x00000000000000000000000000000000000057cc" as const;
const M = 10n ** 18n;
const r = (id: number, px: number, t: bigint): Round => ({ roundId: BigInt(id), answer: BigInt(Math.round(px * 1e8)), updatedAt: t });

function cond(over: Partial<Condition> = {}): Condition {
  return { ...emptyCondition(), kind: Kind.PRICE, mode: PRICE_AT_DEADLINE, op: OP_GTE, target: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", stockToken: TOKEN, threshold: 200_00000000n, multiplier: M, deadline: DL, maxStale: 3600, holdWindow: 3 * 86400, ...over };
}
const ctx = (now: bigint, mult = M) => ({ now, createdAt: DL - 3n * 86400n, currentMultiplier: mult });

describe("AT_DEADLINE", () => {
  test("pending until strictly after the deadline", () => {
    expect(evaluatePrice(cond(), [r(1, 201, DL - 60n)], ctx(DL)).verdict).toBe(Verdict.PENDING);
  });
  test("fresh last round decides; proof is that round", () => {
    const e = evaluatePrice(cond(), [r(1, 195, DL - 7200n), r(2, 201, DL - 1200n), r(3, 150, DL + 60n)], ctx(DL + 120n));
    expect(e.verdict).toBe(Verdict.TRUE);
    expect(e.proofRoundId).toBe(2n);
  });
  test("equality counts (inclusive)", () => {
    expect(evaluatePrice(cond(), [r(1, 200, DL - 10n)], ctx(DL + 1n)).verdict).toBe(Verdict.TRUE);
    expect(evaluatePrice(cond({ op: OP_LTE }), [r(1, 200, DL - 10n)], ctx(DL + 1n)).verdict).toBe(Verdict.TRUE);
  });
  test("false refunds", () => {
    expect(evaluatePrice(cond(), [r(1, 199.99, DL - 10n)], ctx(DL + 1n)).verdict).toBe(Verdict.FALSE);
  });
  test("off-hours hold uses the first print after the deadline", () => {
    const e = evaluatePrice(cond(), [r(1, 190, DL - 20n * 3600n), r(2, 205, DL + 30n * 3600n)], ctx(DL + 31n * 3600n));
    expect(e.verdict).toBe(Verdict.TRUE);
    expect(e.proofRoundId).toBe(1n); // proof is still the last round <= deadline; the contract fetches the next
    expect(e.usedPrice).toBe(205_00000000n);
  });
  test("stale with no print: pending, then VOID after the hold window", () => {
    expect(evaluatePrice(cond(), [r(1, 210, DL - 20n * 3600n)], ctx(DL + 86400n)).verdict).toBe(Verdict.PENDING);
    expect(evaluatePrice(cond(), [r(1, 210, DL - 20n * 3600n)], ctx(DL + 3n * 86400n + 1n)).verdict).toBe(Verdict.VOID);
  });
  test("next print beyond the hold window => VOID", () => {
    expect(evaluatePrice(cond(), [r(1, 210, DL - 20n * 3600n), r(2, 250, DL + 3n * 86400n + 3600n)], ctx(DL + 4n * 86400n)).verdict).toBe(Verdict.VOID);
  });
  test("multiplier change => VOID (never re-applied)", () => {
    expect(evaluatePrice(cond(), [r(1, 400, DL - 10n)], ctx(DL + 1n, 2n * M)).verdict).toBe(Verdict.VOID);
  });
  test("crypto feed (no stock token) ignores multiplier", () => {
    expect(evaluatePrice(cond({ stockToken: "0x0000000000000000000000000000000000000000", multiplier: 0n }), [r(1, 201, DL - 10n)], ctx(DL + 1n, 0n)).verdict).toBe(Verdict.TRUE);
  });
  test("no history at/before the deadline => pending", () => {
    expect(evaluatePrice(cond(), [r(9, 300, DL + 10n)], ctx(DL + 20n)).verdict).toBe(Verdict.PENDING);
  });
  test("unsorted / zero rounds are cleaned", () => {
    const e = evaluatePrice(cond(), [r(3, 150, DL + 60n), r(0, 0, DL - 5n), r(2, 201, DL - 1200n)], ctx(DL + 120n));
    expect(e.proofRoundId).toBe(2n);
  });
});

describe("TOUCH", () => {
  const touch = (over: Partial<Condition> = {}) => cond({ mode: PRICE_TOUCH, maxStale: 0, holdWindow: 0, start: DL - 3n * 86400n, ...over });
  test("first crossing inside the window", () => {
    const e = evaluatePrice(touch(), [r(1, 150, DL - 86400n), r(2, 203, DL - 3600n), r(3, 205, DL - 60n)], ctx(DL - 30n));
    expect(e.verdict).toBe(Verdict.TRUE);
    expect(e.proofRoundId).toBe(2n);
  });
  test("rounds before activeFrom (creation / acceptance) don't count", () => {
    const e = evaluatePrice(touch({ start: DL - 5n * 86400n }), [r(1, 250, DL - 4n * 86400n)], { now: DL - 10n, createdAt: DL - 3n * 86400n, currentMultiplier: M });
    expect(e.verdict).toBe(Verdict.PENDING);
  });
  test("rounds after the deadline don't count", () => {
    expect(evaluatePrice(touch(), [r(1, 250, DL + 1n)], ctx(DL + 5n)).verdict).toBe(Verdict.PENDING);
  });
  test("LTE touch", () => {
    expect(evaluatePrice(touch({ op: OP_LTE, threshold: 150_00000000n }), [r(1, 149, DL - 100n)], ctx(DL - 50n)).verdict).toBe(Verdict.TRUE);
  });
});

describe("New York clock", () => {
  test("DST offsets", () => {
    expect(nyOffsetHours(Date.UTC(2026, 6, 1))).toBe(-4);
    expect(nyOffsetHours(Date.UTC(2026, 11, 1))).toBe(-5);
    expect(nyWallClockToUnix(2026, 11, 2, 16)).toBe(Date.UTC(2026, 10, 2, 21) / 1000); // first Monday after DST end
    expect(nyWallClockToUnix(2026, 10, 30, 16)).toBe(Date.UTC(2026, 9, 30, 20) / 1000);
  });
  test("regular session", () => {
    expect(isRegularSession(Date.UTC(2026, 9, 21, 15) / 1000)).toBe(true); // Wed 11:00 ET
    expect(isRegularSession(Date.UTC(2026, 9, 24, 15) / 1000)).toBe(false); // Saturday
    expect(isRegularSession(Date.UTC(2026, 9, 21, 21) / 1000)).toBe(false); // 17:00 ET
  });
});
