// Watches feeds that have live TOUCH conditions. Walks every new Chainlink round since the last poll (so a
// brief touch between polls is still caught), and settles each crossing with that round as the proof.
import { and, eq, gt, lte } from "drizzle-orm";
import { encodeAbiParameters, type Address } from "viem";
import { ifsoEscrowAbi } from "../abi";
import { crosses } from "../core/price";
import { Kind, PRICE_TOUCH, Status } from "../core/types";
import { escrows } from "../db/schema";
import { required } from "../chain";
import { conditionFromJson } from "./keeper";
import { newRoundsSince } from "./rounds";
import { sendCall } from "./tx";
import type { Deps } from "./deps";

const lastSeen = new Map<string, bigint>();

export async function priceWatchTick(deps: Deps) {
  const now = new Date();
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
  const escrow = required(deps.clients.escrow, "ESCROW_ADDRESS");
  for (const [feed, list] of byFeed) {
    const rounds = await newRoundsSince(deps, feed as Address, lastSeen.get(feed));
    if (rounds.length) lastSeen.set(feed, rounds[rounds.length - 1]!.roundId);
    for (const e of list) {
      const c = conditionFromJson(e.condition as Record<string, unknown>);
      const from = BigInt(Math.floor(e.activeFrom.getTime() / 1000));
      const start = c.start > from ? c.start : from;
      const hit = rounds.find((r) => r.updatedAt >= start && r.updatedAt <= c.deadline && crosses(c, r.answer));
      if (!hit) continue;
      await sendCall(
        deps,
        deps.clients.keeper,
        { address: escrow, abi: ifsoEscrowAbi, functionName: "settle", args: [BigInt(e.id), encodeAbiParameters([{ type: "uint80" }], [hit.roundId]), false] },
        { kind: "settle-touch", escrowId: e.id },
      );
    }
  }
}
