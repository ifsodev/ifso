// Periodic checks that raise ops alerts. Thresholds are exported so tests can assert them.
import { and, eq, gt, gte, inArray, lt, lte, sql, type SQL } from "drizzle-orm";
import { formatEther, formatUnits, type Address } from "viem";
import { erc20Abi } from "viem";
import { aggregatorV3Abi } from "../abi/external";
import { SEED_FEEDS, type FeedInfo } from "../config/chain";
import type { Env } from "../config/env";
import { escrows, questions, cursors, chainEvents } from "../db/schema";
import { isStockFeedSession, stockFeedOpenSeconds } from "../core/price";
import { Status } from "../core/types";
import type { Deps } from "../workers/deps";
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
export const lowBalance = (wei: bigint, minEth: number) => Number(formatEther(wei)) < minEth;

export async function runMonitors(deps: Deps, alert: AlertFn, now = new Date()) {
  const { db, clients, env } = deps;
  // keeper lag: an escrow whose deadline passed more than 10 minutes ago is still open
  const cutoff = new Date(now.getTime() - KEEPER_LAG_MS);
  const lagging = await db.select({ id: escrows.id }).from(escrows).where(and(eq(escrows.status, Status.OPEN), lt(escrows.deadline, cutoff))).limit(5);
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
  for (const a of list) await alert(a.cause, a.text);
  await db.insert(cursors).values({ name: OUTFLOW_CURSOR, block: main.block }).onConflictDoUpdate({ target: cursors.name, set: { block: main.block } });
  return list.length;
}
