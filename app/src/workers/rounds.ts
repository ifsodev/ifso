// Chainlink round history for a feed, phase-aware, cached in price_rounds.
//
// A proxy round id is (phaseId << 64) | aggregatorRound. Most proxies report phase >= 1, but the live SPY, TSLA and
// AAPL feeds report phase 0 (ids like 191), so nothing here assumes a phase number: the phases that exist are
// found from the latest round id downwards, and the first round of phase p is always (p << 64) | 1.
//
// The finder mirrors IfsoConditionEvaluator exactly:
//   - the AT_DEADLINE proof is the LAST round with updatedAt <= deadline (binary search, not a walk back from the head)
//   - "the round after it" is id+1, else the first round of the next phase when this is not the latest round,
//     else none (the feed has not printed again). If the next phase's first round is not readable the contract
//     reverts UnprovableRound, and so do we: the keeper waits and the expiry refund still protects the sender.
import { and, eq } from "drizzle-orm";
import type { Address } from "viem";
import { aggregatorV3Abi } from "../abi/external";
import { evaluatePrice, type PriceEvaluation, type Round } from "../core/price";
import { Verdict, type Condition } from "../core/types";
import { priceRounds } from "../db/schema";
import type { Deps } from "./deps";

export const PHASE_SHIFT = 64n;
const AGG_MASK = (1n << PHASE_SHIFT) - 1n;
export const phaseOf = (id: bigint) => id >> PHASE_SHIFT;
export const aggOf = (id: bigint) => id & AGG_MASK;
export const roundIdOf = (phase: bigint, agg: bigint) => (phase << PHASE_SHIFT) | agg;

export interface RoundSource {
  latest(): Promise<Round>;
  /** undefined when the round does not exist or would be rejected by the evaluator (answer <= 0, updatedAt 0, answeredIn < id). */
  get(id: bigint): Promise<Round | undefined>;
}

export function chainSource(deps: Deps, feed: Address): RoundSource {
  return {
    async latest() {
      const [roundId, answer, , updatedAt] = await deps.clients.publicClient.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" });
      return { roundId, answer, updatedAt };
    },
    async get(id) {
      try {
        const [rid, answer, , updatedAt, answeredIn] = await deps.clients.publicClient.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "getRoundData", args: [id] });
        if (rid !== id || answer <= 0n || updatedAt === 0n || answeredIn < rid) return undefined;
        return { roundId: rid, answer, updatedAt };
      } catch {
        return undefined;
      }
    },
  };
}

/** Rounds never change once written, so every round read from the chain is kept in price_rounds. */
export function cachedSource(deps: Deps, feed: Address): RoundSource {
  const inner = chainSource(deps, feed);
  const key = feed.toLowerCase();
  const remember = async (r: Round) => {
    await deps.db.insert(priceRounds).values({ feed: key, roundId: r.roundId.toString(), answer: r.answer.toString(), updatedAt: new Date(Number(r.updatedAt) * 1000) }).onConflictDoNothing();
  };
  return {
    async latest() {
      const r = await inner.latest();
      if (r.answer > 0n && r.updatedAt > 0n) await remember(r);
      return r;
    },
    async get(id) {
      const [hit] = await deps.db.select().from(priceRounds).where(and(eq(priceRounds.feed, key), eq(priceRounds.roundId, id.toString()))).limit(1);
      if (hit) return { roundId: id, answer: BigInt(hit.answer), updatedAt: BigInt(Math.floor(hit.updatedAt.getTime() / 1000)) };
      const r = await inner.get(id);
      if (r) await remember(r);
      return r;
    },
  };
}

type Probe = { state: "ok"; round: Round } | { state: "new" } | { state: "missing" };

/** The last round with updatedAt <= ts across all phases, or undefined when the feed has none that old.
 *  The newest phase is searched from the latest round downwards (its early rounds need not be readable: the live
 *  phase-0 feeds report ids like 191); an older phase starts from its first round (id 1) and gallops up. */
export async function lastRoundAtOrBefore(src: RoundSource, ts: bigint): Promise<Round | undefined> {
  const latest = await src.latest();
  if (latest.updatedAt === 0n || latest.answer <= 0n) return undefined; // a feed that has never printed
  const top = phaseOf(latest.roundId);
  const topAgg = aggOf(latest.roundId);
  const probe = (p: bigint) => async (k: bigint): Promise<Probe> => {
    if (p === top && k > topAgg) return { state: "new" };
    const r = k < 1n ? undefined : await src.get(roundIdOf(p, k));
    if (!r) return { state: "missing" };
    return r.updatedAt <= ts ? { state: "ok", round: r } : { state: "new" };
  };

  // newest phase
  if (latest.updatedAt <= ts) return latest;
  {
    const at = probe(top);
    let hiNew = topAgg; // known: too new
    let step = 1n;
    let lo: { k: bigint; round: Round } | undefined;
    let missingK: bigint | undefined;
    while (!lo && missingK === undefined) {
      const k = topAgg > step ? topAgg - step : 0n;
      const c = await at(k);
      if (c.state === "new") {
        hiNew = k;
        step *= 2n;
      } else if (c.state === "ok") lo = { k, round: c.round };
      else missingK = k;
    }
    if (!lo) {
      // walked off the readable part of the phase: look for any readable round at or before ts above that point
      let m = missingK!;
      while (!lo && hiNew - m > 1n) {
        const mid = (m + hiNew) / 2n;
        const c = await at(mid);
        if (c.state === "new") hiNew = mid;
        else if (c.state === "missing") m = mid;
        else lo = { k: mid, round: c.round };
      }
    }
    if (lo) return refine(at, lo, hiNew);
  }

  // older phases, newest first
  for (let p = top - 1n; p >= 0n; p--) {
    const first = await src.get(roundIdOf(p, 1n));
    if (!first || first.updatedAt > ts) continue;
    const at = probe(p);
    let lo = { k: 1n, round: first };
    let step = 1n;
    let hiNew: bigint;
    while (true) {
      const c = await at(lo.k + step);
      if (c.state !== "ok") {
        hiNew = lo.k + step;
        break;
      }
      lo = { k: lo.k + step, round: c.round };
      step *= 2n;
    }
    return refine(at, lo, hiNew);
  }
  return undefined;
}

/** Bisect between a readable round at or before ts (lo) and a round number known to be too new / unreadable (hi). */
async function refine(at: (k: bigint) => Promise<Probe>, lo: { k: bigint; round: Round }, hi: bigint): Promise<Round> {
  let best = lo;
  let h = hi;
  while (h - best.k > 1n) {
    const mid = (best.k + h) / 2n;
    const c = await at(mid);
    if (c.state === "ok") best = { k: mid, round: c.round };
    else h = mid;
  }
  return best.round;
}

export type Next = { kind: "round"; round: Round } | { kind: "none" } | { kind: "unprovable" };

/** The round after `id`, as the evaluator's _next sees it. */
export async function nextRound(src: RoundSource, id: bigint, latestId?: bigint): Promise<Next> {
  const n = await src.get(id + 1n);
  if (n) return { kind: "round", round: n };
  const latest = latestId ?? (await src.latest()).roundId;
  if (latest === id) return { kind: "none" };
  const nf = await src.get(roundIdOf(phaseOf(id) + 1n, 1n));
  if (nf) return { kind: "round", round: nf };
  return { kind: "unprovable" };
}

export interface DeadlineDecision extends PriceEvaluation {
  /** The next round could not be read although the feed moved on (the contract would revert UnprovableRound). */
  unprovable?: boolean;
  ref?: Round;
  next?: Round;
}

/** AT_DEADLINE: pick the proof round and the verdict the evaluator will return at chain time `now`. */
export async function decideAtDeadline(
  src: RoundSource,
  c: Condition,
  ctx: { now: bigint; createdAt: bigint; currentMultiplier: bigint },
): Promise<DeadlineDecision> {
  if (ctx.now <= c.deadline) return { verdict: Verdict.PENDING, reason: "deadline not reached" };
  const ref = await lastRoundAtOrBefore(src, c.deadline);
  if (!ref) return { verdict: Verdict.PENDING, reason: "no round at or before the deadline in history" };
  const nx = await nextRound(src, ref.roundId);
  if (nx.kind === "unprovable") return { verdict: Verdict.PENDING, unprovable: true, ref, reason: "next round unreadable: waiting" };
  const next = nx.kind === "round" ? nx.round : undefined;
  const ev = evaluatePrice(c, next ? [ref, next] : [ref], ctx);
  return { ...ev, ref, next };
}

/** Rounds after `afterId` (oldest first), crossing phases, at most `limit`. Stops at the head or an unreadable gap. */
export async function roundsAfter(src: RoundSource, afterId: bigint, limit = 200): Promise<Round[]> {
  const out: Round[] = [];
  const latestId = (await src.latest()).roundId;
  let id = afterId;
  for (let i = 0; i < limit; i++) {
    const nx = await nextRound(src, id, latestId);
    if (nx.kind !== "round") break;
    out.push(nx.round);
    id = nx.round.roundId;
  }
  return out;
}

/** The oldest readable round of the feed (first round of the lowest present phase). */
export async function earliestRound(src: RoundSource): Promise<Round | undefined> {
  const top = phaseOf((await src.latest()).roundId);
  for (let p = 0n; p <= top; p++) {
    const r = await src.get(roundIdOf(p, 1n));
    if (r) return r;
  }
  return undefined;
}
