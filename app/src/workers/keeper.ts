// Keeper: settle what is decidable, refund what expired. Every call it makes is permissionless on-chain, so
// anyone (recipient, sender, a third party) can do the same; this worker only makes it automatic.
// No Chainlink Automation or Gelato on RHC mainnet (verified 2026-10-25), hence a self-hosted BullMQ tick.
//
// Decisions use CHAIN time (the latest block timestamp), the same clock the contract reads. Each pass builds a plan
// (what to call, and whether the keeper believes it will succeed), then either sends it (simulate, estimate, send)
// or, with KEEPER_SHADOW=1, logs the plan next to the eth_call answer and sends nothing.
import { and, asc, eq, gt, inArray, lt, lte } from "drizzle-orm";
import { encodeAbiParameters, type Address, type Hex } from "viem";
import { erc8056Abi, ifsoConditionEvaluatorAbi, ifsoEscrowAbi, ifsoOutcomeResolverAbi } from "../abi";
import { Kind, PRICE_AT_DEADLINE, SRC_PYTH, Status, Verdict, ZERO_ADDRESS, type Condition } from "../core/types";
import { escrows } from "../db/schema";
import { required } from "../chain";
import { cachedSource, decideAtDeadline } from "./rounds";
import { isShadow, sendCall, shadowCall, type ContractCall, type SendResult } from "./tx";
import { raise, type Deps } from "./deps";
import { fetchPythUpdate } from "./pyth";

const BATCH = 50; //   sends per pass
const SCAN = 200; //   rows looked at per pass (rows in backoff are skipped and do not count against it)
const RESOLVER_FINAL = 4;
const RESOLVER_VOID = 5;

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

/** The latest block's timestamp: the clock `settle` and `refund` are judged against. */
export async function chainNow(deps: Deps): Promise<bigint> {
  const b = await deps.clients.publicClient.getBlock({ blockTag: "latest" });
  return b.timestamp;
}

export interface Plan {
  meta: { kind: string; escrowId: string };
  call: ContractCall;
  /** The keeper expects this call to succeed. false: a probe, only executed in shadow mode to compare with eth_call. */
  send: boolean;
  /** The verdict the keeper expects the evaluator to return (settle plans). */
  verdict?: Verdict;
  reason: string;
  /** Extra data for the evaluator probe in shadow mode. */
  probe?: { condition: Condition; activeFrom: bigint; proof: Hex };
}

// ----- per-escrow backoff: a row that keeps failing (frozen refund address, frozen recipient, ...) steps aside so it can
// never sit at the head of a sweep and hide the rows behind it. In memory: a restart simply tries every row once more.
const BACKOFF_BASE_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 6 * 3600_000;
const backoff = new Map<string, { fails: number; until: number }>();
export const resetKeeperBackoff = () => backoff.clear();
const bkey = (pass: string, id: string) => `${pass}:${id}`;
const skipping = (pass: string, id: string, nowMs: number) => (backoff.get(bkey(pass, id))?.until ?? 0) > nowMs;
const skippedIds = (pass: string, nowMs: number) => [...backoff].filter(([k, v]) => k.startsWith(`${pass}:`) && v.until > nowMs).length;
function noteFailure(pass: string, id: string, nowMs: number) {
  const prev = backoff.get(bkey(pass, id));
  const fails = (prev?.fails ?? 0) + 1;
  backoff.set(bkey(pass, id), { fails, until: nowMs + Math.min(BACKOFF_BASE_MS * 2 ** (fails - 1), BACKOFF_MAX_MS) });
}
const noteSuccess = (pass: string, id: string) => backoff.delete(bkey(pass, id));

export async function keeperTick(deps: Deps) {
  const nowTs = await chainNow(deps);
  const now = new Date(Number(nowTs) * 1000);
  for (const [k, v] of backoff) if (v.until < Date.now() - BACKOFF_MAX_MS) backoff.delete(k); // settled long ago
  for (const pass of [settleTime, settlePrice, settleOutcome, refundExpired]) {
    try {
      await pass(deps, now, nowTs);
    } catch (e) {
      deps.log("keeper pass failed", { pass: pass.name, error: String((e as Error)?.message ?? e).slice(0, 300) });
      await raise(deps, `keeper-pass-${pass.name}`, `keeper pass ${pass.name} failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }
}

const settleCall = (deps: Deps, id: string, proof: Hex, value = 0n): ContractCall => ({
  address: required(deps.clients.escrow, "ESCROW_ADDRESS"),
  abi: ifsoEscrowAbi as never,
  functionName: "settle",
  args: [BigInt(id), proof, false],
  value,
});

/** Send (or, in shadow mode, compare) one plan. Returns the result of the send; plans with send=false only run in shadow mode. */
export async function execute(deps: Deps, plan: Plan, wallet = deps.clients.keeper): Promise<SendResult | undefined> {
  if (isShadow(deps)) {
    const res = await shadowCall(deps, wallet, plan.call, plan.meta, { send: plan.send, verdict: plan.verdict === undefined ? undefined : Verdict[plan.verdict], reason: plan.reason });
    let evaluated: Verdict | undefined;
    if (plan.probe && wallet?.account) evaluated = await evaluatorVerdict(deps, wallet.account.address, plan.probe);
    const verdictMismatch = plan.verdict !== undefined && evaluated !== undefined && plan.send && plan.verdict !== evaluated;
    const callMismatch = plan.send !== Boolean(res.simulated);
    if (evaluated !== undefined) deps.log("shadow verdict", { escrowId: plan.meta.escrowId, kind: plan.meta.kind, decided: plan.verdict === undefined ? undefined : Verdict[plan.verdict], ethCall: Verdict[evaluated] });
    if (callMismatch || verdictMismatch) {
      deps.log("shadow MISMATCH", { escrowId: plan.meta.escrowId, kind: plan.meta.kind, send: plan.send, ethCallOk: res.simulated, decided: plan.verdict, evaluated });
      await raise(deps, "shadow-mismatch", `keeper decision and eth_call disagree for escrow ${plan.meta.escrowId} (${plan.meta.kind})`);
    }
    return res;
  }
  if (!plan.send) return undefined;
  const r = await sendCall(deps, wallet, plan.call, plan.meta);
  if (!r.ok) deps.log(`${plan.meta.kind} failed`, { escrowId: plan.meta.escrowId, error: r.error });
  return r;
}

async function evaluatorVerdict(deps: Deps, from: Address, p: { condition: Condition; activeFrom: bigint; proof: Hex }): Promise<Verdict | undefined> {
  try {
    const escrow = required(deps.clients.escrow, "ESCROW_ADDRESS");
    const evaluator = deps.clients.evaluator ?? (await deps.clients.publicClient.readContract({ address: escrow, abi: ifsoEscrowAbi, functionName: "evaluator" }));
    const { result } = await deps.clients.publicClient.simulateContract({
      address: evaluator as Address,
      abi: ifsoConditionEvaluatorAbi,
      functionName: "evaluate",
      args: [p.condition as never, p.activeFrom, p.proof, from],
      account: from,
    } as never);
    return Number(result) as Verdict;
  } catch {
    return undefined; // reverted (BadProof, UnprovableRound, ...): the call comparison already covers it
  }
}

// ---------------------------------------------------------------------------------------------------- TIME
async function settleTime(deps: Deps, now: Date) {
  const due = await deps.db
    .select()
    .from(escrows)
    .where(and(eq(escrows.status, Status.OPEN), eq(escrows.kind, Kind.TIME), lte(escrows.deadline, now), gt(escrows.expiry, now)))
    .orderBy(asc(escrows.deadline))
    .limit(SCAN + skippedIds("time", Date.now()));
  let sends = 0;
  for (const e of due) {
    if (e.twoSided && !e.accepted) continue;
    if (sends >= BATCH || skipping("time", e.id, Date.now())) continue;
    if ((await guarded(deps, "time", e.id, () => execute(deps, { meta: { kind: "settle", escrowId: e.id }, call: settleCall(deps, e.id, "0x"), send: true, verdict: Verdict.TRUE, reason: "deadline reached" })))) sends++;
  }
}

// ---------------------------------------------------------------------------------------------------- PRICE
/** Plan for one PRICE AT_DEADLINE escrow, or undefined when there is nothing to compare or send yet. */
export async function planPrice(deps: Deps, e: typeof escrows.$inferSelect, nowTs: bigint): Promise<Plan | undefined> {
  const c = conditionFromJson(e.condition as Record<string, unknown>);
  if (c.mode !== PRICE_AT_DEADLINE) return undefined; // TOUCH is driven by the price watcher; untouched => expiry refund
  const activeFrom = BigInt(Math.floor(e.activeFrom.getTime() / 1000));
  if (c.source === SRC_PYTH) {
    const upd = await fetchPythUpdate(deps, c.key, Number(c.deadline));
    if (!upd) return undefined;
    const proof = encodeAbiParameters([{ type: "bytes[]" }], [upd.data]);
    return { meta: { kind: "settle", escrowId: e.id }, call: settleCall(deps, e.id, proof, upd.fee), send: true, reason: "pyth update", probe: { condition: c, activeFrom, proof } };
  }
  const multiplier = c.stockToken !== ZERO_ADDRESS ? await deps.clients.publicClient.readContract({ address: c.stockToken, abi: erc8056Abi, functionName: "uiMultiplier" }) : 0n;
  const ev = await decideAtDeadline(cachedSource(deps, c.target), c, { now: nowTs, createdAt: activeFrom, currentMultiplier: multiplier });
  const proofId = ev.proofRoundId ?? ev.ref?.roundId;
  if (proofId === undefined) return undefined;
  const proof = encodeAbiParameters([{ type: "uint80" }], [proofId]);
  const send = ev.verdict !== Verdict.PENDING && ev.proofRoundId !== undefined;
  return { meta: { kind: "settle", escrowId: e.id }, call: settleCall(deps, e.id, proof), send, verdict: send ? ev.verdict : undefined, reason: ev.reason, probe: { condition: c, activeFrom, proof } };
}

async function settlePrice(deps: Deps, now: Date, nowTs: bigint) {
  const due = await deps.db
    .select()
    .from(escrows)
    .where(and(eq(escrows.status, Status.OPEN), eq(escrows.kind, Kind.PRICE), lte(escrows.deadline, now), gt(escrows.expiry, now)))
    .orderBy(asc(escrows.deadline))
    .limit(SCAN + skippedIds("price", Date.now()));
  let sends = 0;
  for (const e of due) {
    if (e.twoSided && !e.accepted) continue;
    if (sends >= BATCH || skipping("price", e.id, Date.now())) continue;
    if (await guarded(deps, "price", e.id, async () => {
      const plan = await planPrice(deps, e, nowTs);
      if (!plan) return;
      if (plan.send) {
        deps.log("price decidable", { id: e.id, verdict: plan.verdict === undefined ? undefined : Verdict[plan.verdict], reason: plan.reason });
      }
      return execute(deps, plan);
    })) sends++;
  }
}

// ---------------------------------------------------------------------------------------------------- OUTCOME
async function settleOutcome(deps: Deps, now: Date) {
  const open = await deps.db
    .select({ id: escrows.id, questionId: escrows.questionId, condition: escrows.condition, twoSided: escrows.twoSided, accepted: escrows.accepted })
    .from(escrows)
    .where(and(eq(escrows.status, Status.OPEN), eq(escrows.kind, Kind.OUTCOME), gt(escrows.expiry, now)))
    .orderBy(asc(escrows.expiry))
    .limit(500 + skippedIds("outcome", Date.now()));
  const byQ = new Map<string, typeof open>();
  for (const e of open) {
    if (!e.questionId || (e.twoSided && !e.accepted)) continue;
    byQ.set(e.questionId, [...(byQ.get(e.questionId) ?? []), e]);
  }
  for (const [qid, list] of byQ) {
    const resolver = conditionFromJson(list[0]!.condition as Record<string, unknown>).target;
    const [state] = await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "outcomeOf", args: [qid as Hex] });
    if (state !== RESOLVER_FINAL && state !== RESOLVER_VOID) continue;
    for (const e of list.filter((x) => !skipping("outcome", x.id, Date.now())).slice(0, BATCH)) {
      await guarded(deps, "outcome", e.id, () => execute(deps, { meta: { kind: "settle", escrowId: e.id }, call: settleCall(deps, e.id, "0x"), send: true, reason: "resolver final" }));
    }
  }
}

// ---------------------------------------------------------------------------------------------------- refunds
async function refundExpired(deps: Deps, now: Date) {
  const escrow = required(deps.clients.escrow, "ESCROW_ADDRESS");
  const refundCall = (id: string, alt: boolean): ContractCall => ({ address: escrow, abi: ifsoEscrowAbi as never, functionName: "refund", args: [BigInt(id), alt, false] });
  const expired = await deps.db
    .select({ id: escrows.id, alt: escrows.altRefundTo })
    .from(escrows)
    .where(and(inArray(escrows.status, [Status.OPEN, Status.MET]), lte(escrows.expiry, now)))
    .orderBy(asc(escrows.expiry))
    .limit(SCAN + skippedIds("refund", Date.now()));
  let refunds = 0;
  for (const e of expired) {
    if (refunds >= BATCH || skipping("refund", e.id, Date.now())) continue;
    if (await guarded(deps, "refund", e.id, async () => {
      const r = await execute(deps, { meta: { kind: "refund", escrowId: e.id }, call: refundCall(e.id, false), send: true, reason: "expired" });
      if (isShadow(deps) || !r || r.ok) return r;
      // primary destination frozen / screened: use the sender's preset alternate (anyone may choose it)
      if (e.alt && e.alt !== ZERO_ADDRESS) {
        const alt = await execute(deps, { meta: { kind: "refund-alt", escrowId: e.id }, call: refundCall(e.id, true), send: true, reason: "expired, primary refused" });
        if (alt && !alt.ok) await raise(deps, `refund-stuck-${e.id}`, `refund of escrow ${e.id} failed on both the primary and the alternate address`);
        return alt;
      }
      await raise(deps, `refund-stuck-${e.id}`, `refund of escrow ${e.id} failed and the sender has no alternate address: ${r.error ?? "unknown"}`);
      return r;
    })) refunds++;
  }
  // unaccepted challenges past acceptBy
  const unaccepted = await deps.db
    .select({ id: escrows.id })
    .from(escrows)
    .where(and(eq(escrows.status, Status.OPEN), eq(escrows.twoSided, true), eq(escrows.accepted, false), lt(escrows.acceptBy, now)))
    .orderBy(asc(escrows.acceptBy))
    .limit(SCAN + skippedIds("unaccepted", Date.now()));
  let freed = 0;
  for (const e of unaccepted) {
    if (freed >= BATCH || skipping("unaccepted", e.id, Date.now())) continue;
    if (await guarded(deps, "unaccepted", e.id, () => execute(deps, { meta: { kind: "refund-unaccepted", escrowId: e.id }, call: refundCall(e.id, false), send: true, reason: "not accepted in time" }))) freed++;
  }
}

/**
 * One bad escrow must not stop the sweep. A thrown error or a failed send (not shadow mode, not "nothing to do")
 * puts the escrow in backoff for this pass; a success clears it.
 */
async function guarded(deps: Deps, pass: string, id: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    const r = (await fn()) as SendResult | undefined;
    if (r && !r.ok && !r.shadow) noteFailure(pass, id, Date.now());
    else if (r?.ok) noteSuccess(pass, id);
    return Boolean(r?.ok);
  } catch (e) {
    noteFailure(pass, id, Date.now());
    deps.log("keeper escrow failed", { id, error: String((e as Error)?.message ?? e).slice(0, 300) });
    return false;
  }
}
