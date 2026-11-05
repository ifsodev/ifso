// Periodic checks that raise ops alerts. Thresholds are exported so tests can assert them.
import { and, asc, eq, gt, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import { formatEther, formatUnits, type Address, type Hex } from "viem";
import { erc20Abi } from "viem";
import { aggregatorV3Abi } from "../abi/external";
import { SEED_FEEDS, type FeedInfo } from "../config/chain";
import type { Env } from "../config/env";
import { escrows, questions, cursors, chainEvents } from "../db/schema";
import { isStockFeedSession, stockFeedOpenSeconds } from "../core/price";
import { Kind, PRICE_AT_DEADLINE, PRICE_TOUCH, SRC_PYTH, Status, Verdict, type Condition } from "../core/types";
import { ifsoOutcomeResolverAbi } from "../abi";
import type { Deps } from "../workers/deps";
import { conditionFromJson } from "../workers/keeper";
import { chainSource, decideAtDeadline } from "../workers/rounds";
import type { AlertFn } from "./alerts";

export const KEEPER_LAG_MS = 10 * 60 * 1000;
export const RESOLVER_UNPROPOSED_MS = 48 * 3600 * 1000;
export const PANEL_SLA_MS = 48 * 3600 * 1000;
export const INDEXER_MAX_BEHIND = 500n;
const QUESTION_PENDING = 1; // IfsoOutcomeResolver state: registered, nothing proposed
const QUESTION_DISPUTED = 3; // proposal disputed, waiting on the panel

/** Pure thresholds, so each alert is unit-testable without a database. */
export const keeperLagged = (decidableSince: Date, now: Date) => now.getTime() - decidableSince.getTime() > KEEPER_LAG_MS;
export const indexerBehind = (head: bigint, cursor: bigint) => head - cursor > INDEXER_MAX_BEHIND;
/**
 * Testnet run 2026-11-01: an OPEN escrow past its deadline is lagging only when the keeper could settle it. A PRICE TOUCH
 * whose level was never reached cannot be settled after its deadline (it pays early on a touch, else it comes back at
 * expiry through the refund sweep), so it is not counted.
 */
export const keeperShouldHaveSettled = (row: { kind: number; condition: unknown }) =>
  !(row.kind === Kind.PRICE && Number((row.condition as { mode?: unknown } | null)?.mode) === PRICE_TOUCH);
/** What keeper-lag needs to know about an open row past its deadline. */
export interface LagRow {
  id: string;
  kind: number;
  condition: unknown;
  questionId: string | null;
  twoSided: boolean;
  accepted: boolean;
  activeFrom: Date;
}
/** Read-only answers keeper-lag asks before counting a row (injected in tests). */
export interface LagProbe {
  /** The verdict the evaluator would give an AT_DEADLINE price now (the keeper's own off-chain mirror). */
  priceVerdict(c: Condition, createdAt: bigint, now: bigint): Promise<Verdict>;
  /** IfsoOutcomeResolver state of a question (4 FINAL, 5 VOID). */
  outcomeState(resolver: Address, questionId: Hex): Promise<number>;
}
const RESOLVER_FINAL = 4;
const RESOLVER_VOID = 5;

/**
 * Testnet run 2026-11-05 (step 70): an open row past its deadline is lagging only if the keeper could settle it NOW.
 * Undecidable by design, so not counted: an untouched TOUCH (see above); an AT_DEADLINE price whose evaluator verdict is
 * still PENDING (stale at the deadline and waiting for the first print inside holdWindow, or the next round not readable
 * yet); an OUTCOME whose question is not FINAL or VOID, or that has no question; an unaccepted challenge (it only refunds
 * at expiry). Once the print lands, or the hold window ends (VOID), the row counts again. A probe that fails counts the
 * row: a broken read must raise the alert, not hide it.
 */
export async function keeperCanSettleNow(row: LagRow, now: bigint, probe: LagProbe): Promise<boolean> {
  if (!keeperShouldHaveSettled(row)) return false;
  if (row.twoSided && !row.accepted) return false;
  try {
    if (row.kind === Kind.PRICE) {
      const c = conditionFromJson(row.condition as Record<string, unknown>);
      if (c.mode !== PRICE_AT_DEADLINE || c.source === SRC_PYTH) return true;
      const createdAt = BigInt(Math.floor(row.activeFrom.getTime() / 1000));
      return (await probe.priceVerdict(c, createdAt, now)) !== Verdict.PENDING;
    }
    if (row.kind === Kind.OUTCOME) {
      if (!row.questionId) return false;
      const resolver = conditionFromJson(row.condition as Record<string, unknown>).target;
      const state = await probe.outcomeState(resolver, row.questionId as Hex);
      return state === RESOLVER_FINAL || state === RESOLVER_VOID;
    }
  } catch {
    return true;
  }
  return true;
}

/** The probe against the chain: feed rounds read directly (no price_rounds cache write) and the resolver's outcomeOf. */
export const chainLagProbe = (deps: Deps): LagProbe => ({
  // the multiplier only turns TRUE/FALSE into VOID, never PENDING into decidable, so the snapshot stands in for it
  priceVerdict: async (c, createdAt, now) =>
    (await decideAtDeadline(chainSource(deps, c.target), c, { now, createdAt, currentMultiplier: c.multiplier })).verdict,
  outcomeState: async (resolver, questionId) => {
    const [state] = await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "outcomeOf", args: [questionId] });
    return Number(state);
  },
});
/** Candidate rows fetched per query (oldest deadline first); the scan pages through all of them (rescore lead, d6b7a57). */
export const LAG_PAGE = 50;
/** Rows probed per run at most (each probe is one or two chain reads). A run that reaches it alerts keeper-lag-scan. */
export const LAG_PROBE_BUDGET = 500;
export interface LagCandidate extends LagRow {
  deadline: Date;
}
/**
 * keeper-lag over EVERY open row past the cutoff, not only the oldest page: rows undecidable for a long time (open
 * OUTCOME questions, AT_DEADLINE prices inside their hold window) must not hide a later real lag. Keyset pages on
 * (deadline, id); stops at 5 lagging rows (the alert names at most 5) or at the probe budget, which it reports.
 */
export async function scanKeeperLag(
  fetchPage: (after: { deadline: Date; id: string } | null, limit: number) => Promise<LagCandidate[]>,
  probe: LagProbe,
  nowSec: bigint,
): Promise<{ lagging: LagCandidate[]; probed: number; incomplete: boolean }> {
  const lagging: LagCandidate[] = [];
  let probed = 0;
  let after: { deadline: Date; id: string } | null = null;
  for (;;) {
    const page = await fetchPage(after, LAG_PAGE);
    for (const r of page) {
      if (lagging.length >= 5) return { lagging, probed, incomplete: false };
      if (probed >= LAG_PROBE_BUDGET) return { lagging, probed, incomplete: true };
      probed++;
      if (await keeperCanSettleNow(r, nowSec, probe)) lagging.push(r);
    }
    if (page.length < LAG_PAGE || lagging.length >= 5) return { lagging, probed, incomplete: false };
    const last = page[page.length - 1]!;
    after = { deadline: last.deadline, id: last.id };
  }
}

export const lowBalance = (wei: bigint, minEth: number) => Number(formatEther(wei)) < minEth;

export async function runMonitors(deps: Deps, alert: AlertFn, now = new Date()) {
  const { db, clients, env } = deps;
  // keeper lag: an escrow whose deadline passed more than 10 minutes ago is still open
  const cutoff = new Date(now.getTime() - KEEPER_LAG_MS);
  // cheap exclusions in SQL (an untouched TOUCH, an unaccepted challenge, an OUTCOME with no question), so they never
  // spend the probe budget; keeperCanSettleNow checks each again
  const lagWhere = and(
    eq(escrows.status, Status.OPEN),
    lt(escrows.deadline, cutoff),
    sql`not (${escrows.kind} = ${Kind.PRICE} and ${escrows.condition}->>'mode' = ${String(PRICE_TOUCH)})`,
    sql`not (${escrows.twoSided} and not ${escrows.accepted})`,
    sql`not (${escrows.kind} = ${Kind.OUTCOME} and ${escrows.questionId} is null)`,
  );
  const fetchPage = async (after: { deadline: Date; id: string } | null, limit: number) =>
    (await db
      .select({ id: escrows.id, kind: escrows.kind, condition: escrows.condition, questionId: escrows.questionId, twoSided: escrows.twoSided, accepted: escrows.accepted, activeFrom: escrows.activeFrom, deadline: escrows.deadline })
      .from(escrows)
      .where(after ? and(lagWhere, sql`(${escrows.deadline}, ${escrows.id}) > (${after.deadline.toISOString()}::timestamptz, ${after.id})`) : lagWhere)
      .orderBy(asc(escrows.deadline), asc(escrows.id))
      .limit(limit)) as LagCandidate[]; // deadline is never null here (lt(deadline, cutoff)) and whole seconds (from chain), so the key round-trips
  const scan = await scanKeeperLag(fetchPage, chainLagProbe(deps), BigInt(Math.floor(now.getTime() / 1000)));
  const lagging = scan.lagging;
  if (scan.incomplete) await alert("keeper-lag-scan", `keeper-lag looked at ${scan.probed} open escrows past their deadline and stopped (probe budget); later ones were not checked this run`);
  if (lagging.length) await alert("keeper-lag", `escrows decidable for over 10 minutes and not settled: ${lagging.map((r) => r.id).join(", ")}`);

  const earliest = new Date(now.getTime() - RESOLVER_UNPROPOSED_MS);
  const unproposed = await db.select({ id: questions.id }).from(questions).where(and(eq(questions.state, QUESTION_PENDING), lt(questions.earliestResolve, earliest))).limit(5);
  if (unproposed.length) await alert("resolver-unproposed", `questions with no proposal 48 hours after the earliest resolve time: ${unproposed.map((r) => r.id).join(", ")}`);

  // panel SLA runs from the dispute time (older rows without one fall back to the earliest resolve time)
  const stuck = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(questions)
    .where(and(eq(questions.state, QUESTION_DISPUTED), sql`coalesce(${questions.disputedAt}, ${questions.earliestResolve}) < ${earliest.toISOString()}::timestamptz`));
  if ((stuck[0]?.n ?? 0) > 0) await alert("panel-sla", `${stuck[0]!.n} disputed question(s) waiting on the panel for over 48 hours`);

  for (const [name, w, min] of [["relayer", clients.relayer, env.MIN_RELAYER_ETH], ["keeper", clients.keeper, env.MIN_KEEPER_ETH], ["resolver", clients.resolver, env.MIN_RESOLVER_ETH]] as const) {
    if (!w?.account) continue;
    const bal = await clients.publicClient.getBalance({ address: w.account.address });
    if (lowBalance(bal, min)) await alert(`low-balance-${name}`, `${name} ${w.account.address} holds ${formatEther(bal)} ETH (minimum ${min})`);
  }
  if (clients.resolver?.account) {
    const usdg = (await clients.publicClient.readContract({ address: clients.usdg, abi: erc20Abi, functionName: "balanceOf", args: [clients.resolver.account.address as Address] })) as bigint;
    if (Number(formatUnits(usdg, 6)) < env.MIN_RESOLVER_USDG) await alert("low-balance-resolver-usdg", `resolver USDG bond float is ${formatUnits(usdg, 6)} (minimum ${env.MIN_RESOLVER_USDG})`);
  }

  const [cur] = await db.select().from(cursors).where(eq(cursors.name, "main"));
  if (cur) {
    const head = await clients.publicClient.getBlockNumber();
    if (indexerBehind(head, cur.block)) await alert("indexer-behind", `indexer is ${head - cur.block} blocks behind the chain head`);
  }

  // each runs even when the other fails
  for (const [name, fn] of [["oracle", () => checkOracles(deps, alert, now)], ["outflow", () => checkOutflow(deps, alert, now)]] as const) {
    try {
      await fn();
    } catch (e) {
      deps.log(`${name} monitor failed`, { error: String((e as Error)?.message ?? e) });
    }
  }
}

// ---------------------------------------------------------------- oracle staleness
export interface FeedProblem {
  kind: "bad-answer" | "stale";
  text: string;
}

const hours = (s: number) => (s / 3600).toFixed(1);

/** What is wrong with a feed's latest round, if anything. Stock feeds only trade 24/5, so their age counts market
 *  hours, and no staleness is reported while the market is closed. A zero or negative answer is reported at any time. */
export function feedProblem(f: FeedInfo, round: { answer: bigint; updatedAt: bigint }, now: number, marginSec: number): FeedProblem | undefined {
  if (round.answer <= 0n)
    return { kind: "bad-answer", text: `The ${f.ticker} price feed ${f.feed} reports ${round.answer}, which is zero or below. Payments on ${f.ticker} must not settle on this price; check the feed first.` };
  const updated = Number(round.updatedAt);
  const limit = f.heartbeat + marginSec;
  if (f.isStock) {
    if (!isStockFeedSession(now)) return undefined;
    const open = stockFeedOpenSeconds(updated, now);
    if (open <= limit) return undefined;
    return {
      kind: "stale",
      text: `The ${f.ticker} price feed ${f.feed} has not updated for ${hours(open)} market hours (heartbeat ${hours(f.heartbeat)} hours plus ${hours(marginSec)} hours margin; last update at unix time ${updated}). Payments on ${f.ticker} cannot use a fresh price until it updates. This counts US market hours only; if today is a US market holiday, this is expected.`,
    };
  }
  const age = now - updated;
  if (age <= limit) return undefined;
  return {
    kind: "stale",
    text: `The ${f.ticker} price feed ${f.feed} has not updated for ${hours(age)} hours (heartbeat ${hours(f.heartbeat)} hours plus ${hours(marginSec)} hours margin; last update at unix time ${updated}). Payments on ${f.ticker} cannot use a fresh price until it updates.`,
  };
}

/** Reads latestRoundData on every feed the app offers and raises one alert per feed and cause. Returns alerts raised. */
export async function checkOracles(deps: Deps, alert: AlertFn, now = new Date(), feeds: readonly FeedInfo[] = SEED_FEEDS): Promise<number> {
  const t = Math.floor(now.getTime() / 1000);
  let raised = 0;
  for (const f of feeds) {
    let answer: bigint, updatedAt: bigint;
    try {
      [, answer, , updatedAt] = (await deps.clients.publicClient.readContract({ address: f.feed, abi: aggregatorV3Abi, functionName: "latestRoundData" })) as readonly [bigint, bigint, bigint, bigint, bigint];
    } catch (e) {
      await alert(`oracle-read-${f.ticker}`, `Could not read the ${f.ticker} price feed ${f.feed}: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 120)}`);
      raised++;
      continue;
    }
    const p = feedProblem(f, { answer, updatedAt }, t, deps.env.ORACLE_STALE_MARGIN_SECONDS);
    if (p) {
      await alert(`oracle-${p.kind}-${f.ticker}`, p.text);
      raised++;
    }
  }
  return raised;
}

// ---------------------------------------------------------------- large outflow
/** Escrow events that send USDG out of the contract to a person (fees to the fee router are not counted). */
export const OUTFLOW_EVENTS = ["Released", "Returned", "Cancelled", "VoidClaimed", "Voided"] as const;
const OUTFLOW_WORDS: Record<string, string> = {
  Released: "release",
  Returned: "return to the sender",
  Cancelled: "cancel refund",
  VoidClaimed: "void claim",
  Voided: "void refund",
};
const OUTFLOW_CURSOR = "outflow-watch";
const ZERO = "0x0000000000000000000000000000000000000000";

export interface Outflow {
  name: string;
  escrowId: string | null;
  to: string;
  amount: bigint;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
}

interface EventRow {
  name: string;
  args: unknown;
  escrowId: string | null;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
}

/** USDG transfers out of the escrow carried by one indexed event (a Voided event can pay two sides). */
export function outflowsOf(r: EventRow): Outflow[] {
  const a = (r.args ?? {}) as Record<string, unknown>;
  const base = { name: r.name, escrowId: r.escrowId, txHash: r.txHash, logIndex: r.logIndex, blockNumber: r.blockNumber };
  const one = (to: unknown, amt: unknown): Outflow[] => {
    const amount = BigInt(String(amt ?? "0"));
    const dest = String(to ?? ZERO).toLowerCase();
    return amount > 0n && dest !== ZERO ? [{ ...base, to: dest, amount }] : [];
  };
  if (r.name === "Voided") return [...one(a.senderTo, a.senderAmount), ...one(a.counterTo, a.counterAmount)];
  if ((OUTFLOW_EVENTS as readonly string[]).includes(r.name)) return one(a.to, a.amount);
  return [];
}

const units = (usdgAmount: number) => BigInt(Math.round(usdgAmount * 1e6));
const fmtUsdg = (v: bigint) => formatUnits(v, 6);

/** Alerts for the transfers in the window (total) and the newly seen transfers (each one above the single level). */
export function outflowAlerts(windowFlows: Outflow[], fresh: Outflow[], env: Pick<Env, "OUTFLOW_WINDOW_USDG" | "OUTFLOW_WINDOW_MINUTES" | "LARGE_RELEASE_USDG">): { cause: string; text: string }[] {
  const out: { cause: string; text: string }[] = [];
  const total = windowFlows.reduce((s, f) => s + f.amount, 0n);
  if (total > units(env.OUTFLOW_WINDOW_USDG))
    out.push({
      cause: "outflow-window",
      text: `${fmtUsdg(total)} USDG left the escrow contract in the last ${env.OUTFLOW_WINDOW_MINUTES} minutes (${windowFlows.length} transfers), above the ${env.OUTFLOW_WINDOW_USDG} USDG alert level. If this was not expected, pause new payments and check the latest Released and Returned events.`,
    });
  for (const f of fresh) {
    if (f.amount <= units(env.LARGE_RELEASE_USDG)) continue;
    out.push({
      cause: `large-release-${f.txHash}-${f.logIndex}`,
      text: `Payment ${f.escrowId ?? "?"} sent ${fmtUsdg(f.amount)} USDG to ${f.to} in one ${OUTFLOW_WORDS[f.name] ?? f.name} (alert level ${env.LARGE_RELEASE_USDG} USDG; tx ${f.txHash}, block ${f.blockNumber}). If this was not expected, pause new payments and check that payment.`,
    });
  }
  return out;
}

/** Reads the escrow's indexed events (chain_events) up to the indexer's cursor, so a block is only read once it is
 *  fully indexed. Single transfers are checked once each, through its own cursor; the first run checks the window. */
export async function checkOutflow(deps: Deps, alert: AlertFn, now = new Date()): Promise<number> {
  const escrow = deps.clients.escrow;
  if (!escrow) return 0;
  const { db, env } = deps;
  const [main] = await db.select().from(cursors).where(eq(cursors.name, "main"));
  if (!main) return 0;
  const [own] = await db.select().from(cursors).where(eq(cursors.name, OUTFLOW_CURSOR));
  const since = new Date(now.getTime() - env.OUTFLOW_WINDOW_MINUTES * 60_000);
  const read = (extra: SQL | undefined) =>
    db
      .select({ name: chainEvents.name, args: chainEvents.args, escrowId: chainEvents.escrowId, txHash: chainEvents.txHash, logIndex: chainEvents.logIndex, blockNumber: chainEvents.blockNumber })
      .from(chainEvents)
      .where(and(sql`lower(${chainEvents.address}) = ${escrow.toLowerCase()}`, inArray(chainEvents.name, [...OUTFLOW_EVENTS]), lte(chainEvents.blockNumber, main.block), extra))
      .orderBy(chainEvents.blockNumber, chainEvents.logIndex);
  const windowRows = await read(gte(chainEvents.blockTime, since));
  const freshRows = own ? await read(gt(chainEvents.blockNumber, own.block)) : windowRows;
  const list = outflowAlerts(windowRows.flatMap(outflowsOf), freshRows.flatMap(outflowsOf), env);
  // Audit I-10: the cursor moves past these blocks only when every per-transfer alert was delivered (sent, or logged
  // while unarmed). A failed send keeps them fresh, so they are raised again once the 30-minute dedupe lets them
  // through. The window total is recomputed from the time window every run, so it does not hold the cursor.
  let delivered = true;
  for (const a of list) {
    const ok = await alert(a.cause, a.text);
    if (a.cause !== "outflow-window" && !ok) delivered = false;
  }
  if (!delivered) {
    deps.log("outflow alert not delivered, outflow cursor held", { at: own?.block?.toString() ?? null });
    return list.length;
  }
  await db.insert(cursors).values({ name: OUTFLOW_CURSOR, block: main.block }).onConflictDoUpdate({ target: cursors.name, set: { block: main.block } });
  return list.length;
}
