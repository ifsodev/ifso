// Periodic checks that raise ops alerts. Thresholds are exported so tests can assert them.
import { and, eq, lt, sql } from "drizzle-orm";
import { formatEther, formatUnits, type Address } from "viem";
import { erc20Abi } from "viem";
import { escrows, questions, cursors } from "../db/schema";
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
}
