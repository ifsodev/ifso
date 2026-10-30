// Watches feeds that have live TOUCH conditions. Walks EVERY Chainlink round since the last poll, across phases (so a
// brief touch between polls is still caught), and settles each crossing with that round as the proof.
//
// The per-feed cursor (the last round id fully handled) lives in the cursors table, so a restart resumes where it
// stopped instead of skipping the rounds printed while the process was down. A cursor only moves past a round once
// every crossing in it is settled, finished by someone else, or given up after MAX_ATTEMPTS ticks (alerted).
import { and, eq, gt, lte } from "drizzle-orm";
import { encodeAbiParameters, type Address } from "viem";
import { ifsoEscrowAbi } from "../abi";
import { crosses, type Round } from "../core/price";
import { Kind, PRICE_TOUCH, Status } from "../core/types";
import { cursors, escrows } from "../db/schema";
import { required } from "../chain";
import { chainNow, conditionFromJson } from "./keeper";
import { cachedSource, earliestRound, lastRoundAtOrBefore, roundsAfter, type RoundSource } from "./rounds";
import { isShadow, sendCall, shadowCall } from "./tx";
import { raise, type Deps } from "./deps";

export const MAX_ATTEMPTS = 10;
const attempts = new Map<string, number>();

const cursorName = (feed: string) => `watch:${feed.toLowerCase()}`;

async function loadCursor(deps: Deps, feed: string): Promise<bigint | undefined> {
  const [row] = await deps.db.select().from(cursors).where(eq(cursors.name, cursorName(feed)));
  return row?.hash ? BigInt(row.hash) : undefined; // the round id (a uint80) is kept in `hash`; `block` is unused
}

async function saveCursor(deps: Deps, feed: string, roundId: bigint) {
  await deps.db
    .insert(cursors)
    .values({ name: cursorName(feed), block: 0n, hash: roundId.toString() })
    .onConflictDoUpdate({ target: cursors.name, set: { hash: roundId.toString() } });
}

/** Where a feed with no cursor starts: the last round before the earliest window start (so nothing in a window is missed). */
async function startingPoint(src: RoundSource, earliestStart: bigint): Promise<bigint | undefined> {
  const before = await lastRoundAtOrBefore(src, earliestStart - 1n);
  if (before) return before.roundId;
  const first = await earliestRound(src);
  return first ? first.roundId - 1n : undefined; // nextRound(first-1) is `first`
}

export async function priceWatchTick(deps: Deps) {
  const nowTs = await chainNow(deps);
  const now = new Date(Number(nowTs) * 1000);
  const live = await deps.db
    .select()
    .from(escrows)
    .where(and(eq(escrows.status, Status.OPEN), eq(escrows.kind, Kind.PRICE), gt(escrows.expiry, now), lte(escrows.activeFrom, now)))
    .limit(2000);
  const byFeed = new Map<string, typeof live>();
  for (const e of live) {
    const c = conditionFromJson(e.condition as Record<string, unknown>);
    if (c.mode !== PRICE_TOUCH || !e.feed) continue;
    if (e.twoSided && !e.accepted) continue;
    byFeed.set(e.feed, [...(byFeed.get(e.feed) ?? []), e]);
  }
  for (const [feed, list] of byFeed) {
    try {
      await watchFeed(deps, feed as Address, list, nowTs);
    } catch (e) {
      deps.log("price watch failed", { feed, error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
}

type Row = typeof escrows.$inferSelect;

/** The escrows this round settles: inside the window and across the threshold. */
export function crossings(list: Row[], r: Round): Row[] {
  return list.filter((e) => {
    const c = conditionFromJson(e.condition as Record<string, unknown>);
    const from = BigInt(Math.floor(e.activeFrom.getTime() / 1000));
    const start = c.start > from ? c.start : from;
    return r.updatedAt >= start && r.updatedAt <= c.deadline && crosses(c, r.answer);
  });
}

const startOf = (e: Row) => {
  const c = conditionFromJson(e.condition as Record<string, unknown>);
  const from = BigInt(Math.floor(e.activeFrom.getTime() / 1000));
  return c.start > from ? c.start : from;
};

/** Escrows seen for the first time by this process: rounds already behind the cursor may hold their crossing
 *  (the indexer can learn of an escrow a few blocks after the round that crossed), so look at those once. */
const scanned = new Set<string>();

/** Forget in-memory state (a process restart, for tests). The cursors in the database stay. */
export function resetWatcherState() {
  scanned.clear();
  attempts.clear();
}

async function watchFeed(deps: Deps, feed: Address, list: Row[], _nowTs: bigint) {
  const src = cachedSource(deps, feed);
  let cursor = await loadCursor(deps, feed);
  if (cursor === undefined) {
    const earliest = list.map(startOf).reduce((a, b) => (a < b ? a : b));
    cursor = await startingPoint(src, earliest);
    if (cursor === undefined) return;
    await saveCursor(deps, feed, cursor);
    for (const e of list) scanned.add(`${feed}:${e.id}`);
  }
  const settled = new Set<string>();
  // 1) backfill: rounds up to the cursor, only for escrows this process has not scanned yet
  for (const e of list.filter((x) => !scanned.has(`${feed}:${x.id}`))) {
    const from = await startingPoint(src, startOf(e));
    if (from !== undefined && from < cursor) {
      const back: Round[] = [];
      for (const r of await roundsAfter(src, from, 5000)) {
        if (r.roundId > cursor) break;
        back.push(r);
      }
      for (const r of back) {
        if (!crossings([e], r).length) continue;
        if (await settleTouch(deps, e, r, settled)) break;
        return; // retry next tick
      }
    }
    scanned.add(`${feed}:${e.id}`);
  }
  // 2) forward: every new round, in order; the cursor moves only past rounds that are fully handled
  const rounds = await roundsAfter(src, cursor);
  for (const r of rounds) {
    for (const e of crossings(list, r)) {
      if (settled.has(e.id)) continue;
      if (!(await settleTouch(deps, e, r, settled))) return; // keep the cursor before this round
    }
    cursor = r.roundId;
    await saveCursor(deps, feed, cursor);
  }
}

/** true: handled (settled, finished by someone else, or given up); false: retry on the next tick. */
async function settleTouch(deps: Deps, e: Row, r: Round, settled: Set<string>): Promise<boolean> {
  const escrow = required(deps.clients.escrow, "ESCROW_ADDRESS");
  const call = { address: escrow, abi: ifsoEscrowAbi as never, functionName: "settle", args: [BigInt(e.id), encodeAbiParameters([{ type: "uint80" }], [r.roundId]), false] as const };
  if (isShadow(deps)) {
    await shadowCall(deps, deps.clients.keeper, call, { kind: "settle-touch", escrowId: e.id }, { send: true, round: r.roundId.toString(), reason: "touch" });
    settled.add(e.id);
    return true;
  }
  const res = await sendCall(deps, deps.clients.keeper, call, { kind: "settle-touch", escrowId: e.id });
  if (res.ok) {
    settled.add(e.id);
    attempts.delete(e.id);
    return true;
  }
  // not mined: finished by someone else (not OPEN any more), or retry on the next tick, then give up loudly
  const state = await deps.clients.publicClient.readContract({ address: escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [BigInt(e.id)] });
  if (state.status !== Status.OPEN) {
    settled.add(e.id);
    return true;
  }
  const n = (attempts.get(e.id) ?? 0) + 1;
  attempts.set(e.id, n);
  if (n < MAX_ATTEMPTS) {
    deps.log("touch settle will retry", { id: e.id, round: r.roundId, attempt: n, error: res.error });
    return false;
  }
  await raise(deps, `touch-stuck-${e.id}`, `touch settle for escrow ${e.id} failed ${n} times (${res.error ?? "unknown"}); skipping round ${r.roundId}`);
  settled.add(e.id);
  return true;
}
