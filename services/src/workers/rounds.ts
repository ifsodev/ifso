// Chainlink round history for a feed (phase-aware), cached in price_rounds. Used to build AT_DEADLINE proofs
// (last round <= deadline, plus the following round) and to scan TOUCH windows between polls.
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import type { Address } from "viem";
import { aggregatorV3Abi } from "../abi/external";
import type { Round } from "../core/price";
import { priceRounds } from "../db/schema";
import type { Deps } from "./deps";

const PHASE_SHIFT = 64n;

export async function latestRound(deps: Deps, feed: Address): Promise<Round> {
  const [roundId, answer, , updatedAt] = await deps.clients.publicClient.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" });
  return { roundId, answer, updatedAt };
}

export async function getRound(deps: Deps, feed: Address, roundId: bigint): Promise<Round | undefined> {
  try {
    const [rid, answer, , updatedAt] = await deps.clients.publicClient.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "getRoundData", args: [roundId] });
    if (updatedAt === 0n || answer <= 0n) return undefined;
    return { roundId: rid, answer, updatedAt };
  } catch {
    return undefined;
  }
}

async function cache(deps: Deps, feed: Address, rs: Round[]) {
  if (!rs.length) return;
  await deps.db
    .insert(priceRounds)
    .values(rs.map((r) => ({ feed: feed.toLowerCase(), roundId: r.roundId.toString(), answer: r.answer.toString(), updatedAt: new Date(Number(r.updatedAt) * 1000) })))
    .onConflictDoNothing();
}

/** Walks back from the latest round until it has passed `notAfter - lookback`. Phase boundaries stop the walk
 *  (older phases are reached via the cache filled while they were live). */
export async function roundsAround(deps: Deps, feed: Address, fromTs: bigint, maxSteps = 600): Promise<Round[]> {
  const out: Round[] = [];
  let r: Round | undefined = await latestRound(deps, feed);
  for (let i = 0; i < maxSteps && r; i++) {
    out.push(r);
    if (r.updatedAt < fromTs) break;
    const agg = r.roundId & ((1n << PHASE_SHIFT) - 1n);
    if (agg <= 1n) break;
    r = await getRound(deps, feed, r.roundId - 1n);
  }
  await cache(deps, feed, out);
  const cached = await deps.db
    .select()
    .from(priceRounds)
    .where(and(eq(priceRounds.feed, feed.toLowerCase()), gte(priceRounds.updatedAt, new Date(Number(fromTs) * 1000))))
    .orderBy(asc(priceRounds.updatedAt));
  const merged = new Map<string, Round>();
  for (const c of cached) merged.set(c.roundId, { roundId: BigInt(c.roundId), answer: BigInt(c.answer), updatedAt: BigInt(Math.floor(c.updatedAt.getTime() / 1000)) });
  for (const o of out) merged.set(o.roundId.toString(), o);
  // include the last round before fromTs (needed as the "reference" when everything after is later)
  const before = await deps.db
    .select()
    .from(priceRounds)
    .where(and(eq(priceRounds.feed, feed.toLowerCase()), lte(priceRounds.updatedAt, new Date(Number(fromTs) * 1000))))
    .orderBy(desc(priceRounds.updatedAt))
    .limit(1);
  for (const c of before) merged.set(c.roundId, { roundId: BigInt(c.roundId), answer: BigInt(c.answer), updatedAt: BigInt(Math.floor(c.updatedAt.getTime() / 1000)) });
  return [...merged.values()];
}

/** New rounds since `lastSeen` (inclusive of later phases' first rounds via latest). */
export async function newRoundsSince(deps: Deps, feed: Address, lastSeen: bigint | undefined, maxSteps = 200): Promise<Round[]> {
  const latest = await latestRound(deps, feed);
  if (lastSeen !== undefined && latest.roundId === lastSeen) return [];
  const out: Round[] = [latest];
  let id = latest.roundId;
  for (let i = 0; i < maxSteps; i++) {
    if (lastSeen !== undefined && id - 1n <= lastSeen) break;
    if ((id & ((1n << PHASE_SHIFT) - 1n)) <= 1n) break;
    const r = await getRound(deps, feed, id - 1n);
    if (!r) break;
    out.push(r);
    id = r.roundId;
    if (lastSeen === undefined) break;
  }
  await cache(deps, feed, out);
  return out.reverse();
}
