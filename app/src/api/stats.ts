// Real-user counter from the indexed chain events only (never from our own relay logs or Telegram users).
import { and, inArray, sql } from "drizzle-orm";
import { computeUserStats, type StatEvent, type UserStats } from "../core/stats";
import { internalAddresses } from "../config/env";
import { chainEvents } from "../db/schema";
import type { Deps } from "../workers/deps";

export async function userStats(deps: Deps, sinceSec?: number): Promise<UserStats> {
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
