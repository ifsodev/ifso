// Off-chain mirror of IfsoConditionEvaluator's PRICE logic. The keeper uses it to pick the exact proof
// (the round id the contract needs) and to know when a settle tx will succeed; the bot uses it for previews.
// Semantics MUST match the contract (see test/price.test.ts):
//  AT_DEADLINE: reference = last round with updatedAt <= deadline. If (deadline - updatedAt) <= maxStale use it;
//               else use the next round if it arrives within holdWindow after the deadline ("off-hours hold");
//               no such print => VOID once now > deadline + holdWindow. Only decidable when now > deadline.
//  TOUCH:       TRUE on the first round with max(start, createdAt) <= updatedAt <= deadline that crosses;
//               otherwise PENDING (refund at expiry).
//  Multiplier:  current uiMultiplier != creation snapshot => VOID (feeds already embed the multiplier).
import { OP_GTE, PRICE_TOUCH, Verdict, type Condition } from "./types";

export interface Round {
  roundId: bigint;
  answer: bigint; // 8 decimals, already includes the Stock Token multiplier
  updatedAt: bigint; // unix seconds
}

export interface PriceEvaluation {
  verdict: Verdict;
  proofRoundId?: bigint; // what to pass to settle(id, abi.encode(uint80 roundId), ...)
  usedPrice?: bigint;
  reason: string;
}

export function crosses(c: Pick<Condition, "op" | "threshold">, px: bigint): boolean {
  return c.op === OP_GTE ? px >= c.threshold : px <= c.threshold;
}

function sorted(rounds: Round[]): Round[] {
  return [...rounds].filter((r) => r.answer > 0n && r.updatedAt > 0n).sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
}

export function evaluatePrice(
  c: Condition,
  rounds: Round[],
  ctx: { now: bigint; createdAt: bigint; currentMultiplier: bigint },
): PriceEvaluation {
  const rs = sorted(rounds);
  const multiplierChanged = c.stockToken !== "0x0000000000000000000000000000000000000000" && ctx.currentMultiplier !== c.multiplier;

  if (c.mode === PRICE_TOUCH) {
    const from = c.start > ctx.createdAt ? c.start : ctx.createdAt;
    const hit = rs.find((r) => r.updatedAt >= from && r.updatedAt <= c.deadline && crosses(c, r.answer));
    if (!hit) return { verdict: Verdict.PENDING, reason: "not touched inside the window" };
    if (multiplierChanged) return { verdict: Verdict.VOID, proofRoundId: hit.roundId, reason: "corporate action changed the multiplier" };
    return { verdict: Verdict.TRUE, proofRoundId: hit.roundId, usedPrice: hit.answer, reason: "touched" };
  }

  if (ctx.now <= c.deadline) return { verdict: Verdict.PENDING, reason: "deadline not reached" };
  let idx = -1;
  for (let i = 0; i < rs.length; i++) if (rs[i]!.updatedAt <= c.deadline) idx = i;
  if (idx < 0) return { verdict: Verdict.PENDING, reason: "no round at or before the deadline in history" };
  const ref = rs[idx]!;
  const next = rs[idx + 1];

  let px: bigint;
  let reason: string;
  if (c.deadline - ref.updatedAt <= BigInt(c.maxStale)) {
    px = ref.answer;
    reason = "price in force at the deadline";
  } else if (next) {
    if (next.updatedAt - c.deadline > BigInt(c.holdWindow)) {
      return { verdict: Verdict.VOID, proofRoundId: ref.roundId, reason: "no print within the hold window" };
    }
    px = next.answer;
    reason = "off-hours hold: first print after the deadline";
  } else {
    if (ctx.now > c.deadline + BigInt(c.holdWindow)) {
      return { verdict: Verdict.VOID, proofRoundId: ref.roundId, reason: "no print within the hold window" };
    }
    return { verdict: Verdict.PENDING, proofRoundId: ref.roundId, reason: "market closed: waiting for the next print" };
  }
  if (multiplierChanged) return { verdict: Verdict.VOID, proofRoundId: ref.roundId, reason: "corporate action changed the multiplier" };
  return {
    verdict: crosses(c, px) ? Verdict.TRUE : Verdict.FALSE,
    proofRoundId: ref.roundId,
    usedPrice: px,
    reason,
  };
}

// ---------------------------------------------------------------- US market calendar helpers
/** America/New_York UTC offset in hours for a given UTC instant (US DST: 2nd Sunday Mar -> 1st Sunday Nov, 2am local). */
export function nyOffsetHours(utcMs: number): number {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const nthSunday = (month: number, n: number) => {
    const first = new Date(Date.UTC(y, month, 1));
    const day = 1 + ((7 - first.getUTCDay()) % 7) + 7 * (n - 1);
    return day;
  };
  const dstStart = Date.UTC(y, 2, nthSunday(2, 2), 7); // 2:00 EST = 07:00 UTC
  const dstEnd = Date.UTC(y, 10, nthSunday(10, 1), 6); //   2:00 EDT = 06:00 UTC
  return utcMs >= dstStart && utcMs < dstEnd ? -4 : -5;
}

/** Unix seconds for a New York wall-clock time (handles DST). */
export function nyWallClockToUnix(y: number, month1: number, day: number, hour: number, minute = 0): number {
  const guess = Date.UTC(y, month1 - 1, day, hour, minute);
  const off = nyOffsetHours(guess - 5 * 3600_000);
  return Math.floor((guess - off * 3600_000) / 1000);
}

/** True when US equities trade in the regular session (Mon-Fri 9:30-16:00 ET); holidays not modelled (U). */
export function isRegularSession(unix: number): boolean {
  const ms = unix * 1000;
  const local = new Date(ms + nyOffsetHours(ms) * 3600_000);
  const dow = local.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/** True while the RHC Stock Token feeds trade: 24/5, Sunday 20:00 ET to Friday 20:00 ET (Chainlink directory category
 *  "us_equities_24/5"). Holidays not modelled (U). */
export function isStockFeedSession(unix: number): boolean {
  const ms = unix * 1000;
  const local = new Date(ms + nyOffsetHours(ms) * 3600_000);
  const dow = local.getUTCDay();
  const h = local.getUTCHours();
  if (dow === 6) return false;
  if (dow === 0) return h >= 20;
  if (dow === 5) return h < 20;
  return true;
}

const STOCK_OPEN_SCAN_MAX = 14 * 86400;

/** Seconds of stock-feed session between two instants. Session edges fall on whole hours (the ET offset is whole
 *  hours too), so each UTC hour slice is all open or all closed. Spans past 14 days count the first 14 days' worth. */
export function stockFeedOpenSeconds(fromUnix: number, toUnix: number): number {
  let t = fromUnix;
  const end = Math.min(toUnix, fromUnix + STOCK_OPEN_SCAN_MAX);
  let open = 0;
  while (t < end) {
    const next = Math.min(end, (Math.floor(t / 3600) + 1) * 3600);
    if (isStockFeedSession(t)) open += next - t;
    t = next;
  }
  return open;
}
