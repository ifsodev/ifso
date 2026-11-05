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

// Testnet run 2026-11-05 step 70: an AT_DEADLINE price challenge ("eth <= 2000", deadline 18:38:13) whose last feed
// round (17:38:12) was 3,601 s old at the deadline, 1 s past maxStale 3,600. The evaluator correctly waited for the
// first print after the deadline (off-hours hold, holdWindow 4 days), yet keeper-lag fired at 18:48 ("decidable for
// over 10 minutes and not settled"). Same class as the 2026-11-01 TOUCH: a row the evaluator cannot decide yet is not
// lagging. The rule now asks the off-chain evaluator mirror (PRICE) and the resolver (OUTCOME) before counting a row.
import { keeperCanSettleNow, type LagProbe, type LagRow } from "../src/ops/monitors";
import { decideAtDeadline, type RoundSource } from "../src/workers/rounds";
import { conditionFromJson } from "../src/workers/keeper";
import { OP_LTE, SRC_CHAINLINK, Verdict } from "../src/core/types";
import type { Round } from "../src/core/price";

describe("keeper-lag skips rows that are undecidable by design (testnet 2026-11-05 step 70)", () => {
  const deadline = 1_793_904_293n; // 2026-11-05 18:38:13 UTC
  const lastRound: Round = { roundId: 10n, answer: 2250_00000000n, updatedAt: deadline - 3601n }; // 17:38:12
  const condition = {
    kind: Kind.PRICE, mode: PRICE_AT_DEADLINE, op: OP_LTE, source: SRC_CHAINLINK,
    target: "0x6ba540c3638cac8047599dA9fB09c03BE834b725", stockToken: "0x0000000000000000000000000000000000000000",
    key: "0x00", threshold: "200000000000", multiplier: "0", outcomeMask: "0", start: "0",
    deadline: String(deadline), maxStale: 3600, holdWindow: 4 * 86400,
  };
  const row = (over: Partial<LagRow> = {}): LagRow => ({
    id: "48430460974255565791953230631076844270560527066133517026997765161845039411888", kind: Kind.PRICE, condition,
    questionId: null, twoSided: true, accepted: true, activeFrom: new Date(Number(deadline - 4500n) * 1000), ...over,
  });
  const feed = (rounds: Round[]): RoundSource => ({
    latest: async () => rounds[rounds.length - 1]!,
    get: async (id) => rounds.find((r) => r.roundId === id),
  });
  const probe = (rounds: Round[], outcome = 0): LagProbe => ({
    priceVerdict: async (c, createdAt, now) => (await decideAtDeadline(feed(rounds), c, { now, createdAt, currentMultiplier: 0n })).verdict,
    outcomeState: async () => outcome,
  });
  const at1848 = deadline + 9n * 60n + 47n; // 18:48:00, when the false alert fired

  test("stale at the deadline, waiting inside the hold window: not lagging", async () => {
    expect(conditionFromJson(condition).maxStale).toBe(3600);
    expect(await keeperCanSettleNow(row(), at1848, probe([lastRound]))).toBe(false);
  });
  test("once the first print after the deadline lands it is decidable and counts", async () => {
    const print: Round = { roundId: 11n, answer: 2250_00000000n, updatedAt: deadline + 730n }; // 18:50:23
    expect(await keeperCanSettleNow(row(), deadline + 1000n, probe([lastRound, print]))).toBe(true);
  });
  test("no print by the end of the hold window: VOID is decidable and counts", async () => {
    expect(await keeperCanSettleNow(row(), deadline + 4n * 86400n + 1n, probe([lastRound]))).toBe(true);
  });
  test("a fresh price at the deadline counts as before", async () => {
    const fresh: Round = { roundId: 10n, answer: 2250_00000000n, updatedAt: deadline - 3599n };
    expect(await keeperCanSettleNow(row(), at1848, probe([fresh]))).toBe(true);
  });
  test("an OUTCOME counts only once its question is FINAL or VOID", async () => {
    const o = row({ kind: Kind.OUTCOME, condition: { kind: Kind.OUTCOME, mode: 0, target: "0x566f2CF9745De48D7A75e10840B877344a924C96" }, questionId: "0xd4" });
    for (const open of [1, 2, 3]) expect(await keeperCanSettleNow(o, at1848, probe([], open))).toBe(false);
    expect(await keeperCanSettleNow(o, at1848, probe([], 4))).toBe(true);
    expect(await keeperCanSettleNow(o, at1848, probe([], 5))).toBe(true);
    expect(await keeperCanSettleNow({ ...o, questionId: null }, at1848, probe([], 4))).toBe(false);
  });
  test("an unaccepted challenge only refunds at expiry: not lagging", async () => {
    expect(await keeperCanSettleNow(row({ accepted: false, kind: Kind.TIME, condition: { kind: Kind.TIME } }), at1848, probe([]))).toBe(false);
  });
  test("a TIME payment counts; a probe that fails counts too (alert rather than hide)", async () => {
    expect(await keeperCanSettleNow(row({ kind: Kind.TIME, condition: { kind: Kind.TIME } }), at1848, probe([]))).toBe(true);
    const broken: LagProbe = { priceVerdict: async () => { throw new Error("rpc down"); }, outcomeState: async () => { throw new Error("rpc down"); } };
    expect(await keeperCanSettleNow(row(), at1848, broken)).toBe(true);
  });
});
