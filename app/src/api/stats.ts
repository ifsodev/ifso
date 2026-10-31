// Real-user counter from the indexed chain events only (never from our own relay logs or Telegram users).
import { and, inArray, sql } from "drizzle-orm";
import { computeUserStats, type StatEvent, type UserStats } from "../core/stats";
import { internalAddresses } from "../config/env";
import { chainEvents } from "../db/schema";
import type { Deps } from "../workers/deps";

/** Review R3-L1: one computation per minute for every caller (keyed by deps and `since`), not one full scan per request. */
export const STATS_TTL_MS = 60_000;
const cache = new WeakMap<object, Map<string, { at: number; value: Promise<UserStats> }>>();

export async function userStats(deps: Deps, sinceSec?: number, nowMs = Date.now()): Promise<UserStats> {
  let m = cache.get(deps);
  if (!m) cache.set(deps, (m = new Map()));
  const key = String(sinceSec ?? "");
  const hit = m.get(key);
  if (hit && nowMs - hit.at < STATS_TTL_MS) return hit.value;
  if (m.size >= 500) m.clear();
  const value = computeStats(deps, sinceSec);
  m.set(key, { at: nowMs, value });
  value.catch(() => m!.delete(key)); // a failed scan is not cached
  return value;
}

async function computeStats(deps: Deps, sinceSec?: number): Promise<UserStats> {
  const escrow = deps.clients.escrow?.toLowerCase();
  const rows = await deps.db
    .select({ name: chainEvents.name, args: chainEvents.args, blockTime: chainEvents.blockTime })
    .from(chainEvents)
    .where(and(inArray(chainEvents.name, ["Created", "Accepted", "Claimed"]), escrow ? sql`lower(${chainEvents.address}) = ${escrow}` : sql`true`));
  const events: StatEvent[] = rows.map((r) => {
    const a = r.args as Record<string, unknown>;
    return { name: r.name, blockTime: r.blockTime ? Math.floor(r.blockTime.getTime() / 1000) : null, args: a };
  });
  return computeUserStats(events, internalAddresses(deps.env), sinceSec);
}
