// Keeper: settle what is decidable, refund what expired. Every call it makes is permissionless on-chain, so
// anyone (recipient, sender, a third party) can do the same; this worker only makes it automatic.
// No Chainlink Automation or Gelato on RHC mainnet (verified 2026-10-25), hence a self-hosted BullMQ tick.
import { and, eq, inArray, lte } from "drizzle-orm";
import { encodeAbiParameters, type Address, type Hex } from "viem";
import { erc8056Abi, ifsoEscrowAbi, ifsoOutcomeResolverAbi } from "../abi";
import { evaluatePrice } from "../core/price";
import { Kind, PRICE_AT_DEADLINE, SRC_PYTH, Status, Verdict, type Condition } from "../core/types";
import { escrows } from "../db/schema";
import { required } from "../chain";
import { roundsAround } from "./rounds";
import { sendCall } from "./tx";
import type { Deps } from "./deps";
import { fetchPythUpdate } from "./pyth";

const BATCH = 50;

export function conditionFromJson(j: Record<string, unknown>): Condition {
  const b = (k: string) => BigInt(String(j[k] ?? 0));
  return {
    kind: Number(j.kind),
    mode: Number(j.mode),
    op: Number(j.op),
    source: Number(j.source),
    target: j.target as Address,
    stockToken: j.stockToken as Address,
    key: j.key as Hex,
    threshold: b("threshold"),
    multiplier: b("multiplier"),
    outcomeMask: b("outcomeMask"),
    start: b("start"),
    deadline: b("deadline"),
    maxStale: Number(j.maxStale),
    holdWindow: Number(j.holdWindow),
  };
}

export async function keeperTick(deps: Deps) {
  const now = new Date();
  await settleTime(deps, now);
  await settlePrice(deps, now);
  await settleOutcome(deps);
  await refundExpired(deps, now);
}

async function settle(deps: Deps, id: string, proof: Hex = "0x", value = 0n) {
  const escrow = required(deps.clients.escrow, "ESCROW_ADDRESS");
  return sendCall(deps, deps.clients.keeper, { address: escrow, abi: ifsoEscrowAbi, functionName: "settle", args: [BigInt(id), proof, false], value }, { kind: "settle", escrowId: id });
}

async function settleTime(deps: Deps, now: Date) {
  const due = await deps.db
    .select({ id: escrows.id })
    .from(escrows)
    .where(and(eq(escrows.status, Status.OPEN), eq(escrows.kind, Kind.TIME), lte(escrows.deadline, now)))
    .limit(BATCH);
  for (const e of due) await settle(deps, e.id);
}

async function settlePrice(deps: Deps, now: Date) {
  const due = await deps.db
    .select()
    .from(escrows)
    .where(and(eq(escrows.status, Status.OPEN), eq(escrows.kind, Kind.PRICE), lte(escrows.deadline, now)))
    .limit(BATCH);
  for (const e of due) {
    if (e.twoSided && !e.accepted) continue;
    const c = conditionFromJson(e.condition as Record<string, unknown>);
    if (c.mode !== PRICE_AT_DEADLINE) continue; // TOUCH is driven by the price watcher; untouched => expiry refund
    if (c.source === SRC_PYTH) {
      const upd = await fetchPythUpdate(deps, c.key, Number(c.deadline));
      if (upd) await settle(deps, e.id, encodeAbiParameters([{ type: "bytes[]" }], [upd.data]), upd.fee);
      continue;
    }
    const multiplier = c.stockToken !== "0x0000000000000000000000000000000000000000"
      ? await deps.clients.publicClient.readContract({ address: c.stockToken, abi: erc8056Abi, functionName: "uiMultiplier" })
      : 0n;
    const rounds = await roundsAround(deps, c.target, c.deadline - BigInt(c.maxStale) - 3600n);
    const ev = evaluatePrice(c, rounds, { now: BigInt(Math.floor(now.getTime() / 1000)), createdAt: BigInt(Math.floor(e.activeFrom.getTime() / 1000)), currentMultiplier: multiplier });
    if (ev.verdict === Verdict.PENDING || ev.proofRoundId === undefined) continue;
    deps.log("price decidable", { id: e.id, verdict: Verdict[ev.verdict], reason: ev.reason });
    await settle(deps, e.id, encodeAbiParameters([{ type: "uint80" }], [ev.proofRoundId]));
  }
}

async function settleOutcome(deps: Deps) {
  const open = await deps.db
    .select({ id: escrows.id, questionId: escrows.questionId, condition: escrows.condition, twoSided: escrows.twoSided, accepted: escrows.accepted })
    .from(escrows)
    .where(and(eq(escrows.status, Status.OPEN), eq(escrows.kind, Kind.OUTCOME)))
    .limit(500);
  const byQ = new Map<string, typeof open>();
  for (const e of open) {
    if (!e.questionId || (e.twoSided && !e.accepted)) continue;
    byQ.set(e.questionId, [...(byQ.get(e.questionId) ?? []), e]);
  }
  for (const [qid, list] of byQ) {
    const resolver = conditionFromJson(list[0]!.condition as Record<string, unknown>).target;
    const [state] = await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "outcomeOf", args: [qid as Hex] });
    if (state !== 4 && state !== 5) continue; // FINAL or VOID
    for (const e of list.slice(0, BATCH)) await settle(deps, e.id);
  }
}

async function refundExpired(deps: Deps, now: Date) {
  const escrow = required(deps.clients.escrow, "ESCROW_ADDRESS");
  const expired = await deps.db
    .select({ id: escrows.id, alt: escrows.altRefundTo })
    .from(escrows)
    .where(and(inArray(escrows.status, [Status.OPEN, Status.MET]), lte(escrows.expiry, now)))
    .limit(BATCH);
  for (const e of expired) {
    const r = await sendCall(deps, deps.clients.keeper, { address: escrow, abi: ifsoEscrowAbi, functionName: "refund", args: [BigInt(e.id), false, false] }, { kind: "refund", escrowId: e.id });
    // primary destination frozen / screened: use the sender's preset alternate (anyone may choose it)
    if (!r.ok && e.alt && e.alt !== "0x0000000000000000000000000000000000000000") {
      await sendCall(deps, deps.clients.keeper, { address: escrow, abi: ifsoEscrowAbi, functionName: "refund", args: [BigInt(e.id), true, false] }, { kind: "refund-alt", escrowId: e.id });
    }
  }
  // unaccepted challenges past acceptBy
  const unaccepted = await deps.db
    .select({ id: escrows.id })
    .from(escrows)
    .where(and(eq(escrows.status, Status.OPEN), eq(escrows.twoSided, true), eq(escrows.accepted, false), lte(escrows.acceptBy, now)))
    .limit(BATCH);
  for (const e of unaccepted) {
    await sendCall(deps, deps.clients.keeper, { address: escrow, abi: ifsoEscrowAbi, functionName: "refund", args: [BigInt(e.id), false, false] }, { kind: "refund-unaccepted", escrowId: e.id });
  }
}
