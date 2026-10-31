// Real-user counter from the indexed chain events only (never from our own relay logs or Telegram users).
import { and, inArray, sql } from "drizzle-orm";
import { computeUserStats, type StatEvent, type UserStats } from "../core/stats";
import { internalAddresses } from "../config/env";
import { chainEvents } from "../db/schema";
import type { Deps } from "../workers/deps";

/**
 * Review R3-L1 / audit L-2: ONE database scan per minute for every caller, whatever `since` they pass (varying the date
 * used to force a fresh full scan per distinct value). Each `since` is then computed in memory from that scan, and
 * `since` is clamped to [0, today] so the per-`since` answer cache stays small.
 */
export const STATS_TTL_MS = 60_000;
const scans = new WeakMap<object, { at: number; value: Promise<StatEvent[]> }>();
const answers = new WeakMap<object, Map<string, { at: number; value: Promise<UserStats> }>>();

export async function userStats(deps: Deps, sinceSec?: number, nowMs = Date.now()): Promise<UserStats> {
  const since = sinceSec === undefined ? undefined : Math.min(Math.max(0, sinceSec), Math.floor(nowMs / 86_400_000) * 86_400);
  let m = answers.get(deps);
  if (!m) answers.set(deps, (m = new Map()));
  const key = String(since ?? "");
  const hit = m.get(key);
  if (hit && nowMs - hit.at < STATS_TTL_MS) return hit.value;
  if (m.size >= 500) m.clear();
  let scan = scans.get(deps);
  if (!scan || nowMs - scan.at >= STATS_TTL_MS) {
    const value = scanEvents(deps);
    scans.set(deps, (scan = { at: nowMs, value }));
    value.catch(() => scans.delete(deps)); // a failed scan is not cached
  }
  const value = scan.value.then((events) => computeUserStats(events, internalAddresses(deps.env), since));
  m.set(key, { at: nowMs, value });
  value.catch(() => m!.delete(key));
  return value;
}

async function scanEvents(deps: Deps): Promise<StatEvent[]> {
  const escrow = deps.clients.escrow?.toLowerCase();
  const rows = await deps.db
    .select({ name: chainEvents.name, args: chainEvents.args, blockTime: chainEvents.blockTime })
    .from(chainEvents)
    .where(and(inArray(chainEvents.name, ["Created", "Accepted", "Claimed"]), escrow ? sql`lower(${chainEvents.address}) = ${escrow}` : sql`true`));
  return rows.map((r) => {
    const a = r.args as Record<string, unknown>;
    return { name: r.name, blockTime: r.blockTime ? Math.floor(r.blockTime.getTime() / 1000) : null, args: a };
  });
}
