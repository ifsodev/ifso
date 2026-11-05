// Outcome resolver service for IfsoOutcomeResolver (studio-run, bonded, optimistic).
//  - plans questions lazily (build); the api registers them with the RELAYER key, the question creator, for a funded
//    create (submit); this service with the RESOLVER key never creates questions, it bonds and resolves them
//  - after earliestResolve: reads >= 2 independent sources, proposes only on agreement (USDG bond)
//  - watches proposals made by anyone else and disputes the ones its sources contradict
//  - finalizes undisputed proposals after the window; times out silent panels (=> VOID => refunds)
import { and, asc, desc, eq, exists, gt, inArray, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { encodeAbiParameters, keccak256, maxUint256, type Address, type Hex } from "viem";
import { ifsoOutcomeResolverAbi, usdgAbi } from "../abi";
import { agree, questionSpecHash, type Agreement, type SourceReport } from "../core/outcome";
import { DEFAULTS } from "../core/builder";
import { classifyForeign, planForeignDisputes, type ForeignCandidate } from "../core/disputePolicy";
import { cursors, escrows, questions, sourceReports } from "../db/schema";
import { required } from "../chain";
import { liveSources } from "../sources";
import type { GammaMarket } from "../sources/polymarket";
import type { Env } from "../config/env";
import { chainNow } from "./keeper";
import { sendCall } from "./tx";
import { raise, type Deps } from "./deps";
import { questionSettled } from "./outcomeWaits";

const sources = (deps: Deps) => deps.sources ?? liveSources;

export const FOOTBALL_RULE =
  "League fixture. Result after 90 minutes plus stoppage time. Postponed, abandoned, suspended or awarded => VOID.";
const FOOTBALL_RESOLVE_DELAY = 150 * 60; // kickoff + 2h30

export function questionIdFor(specHash: Hex, closeTime: number, earliestResolve: number, numOutcomes: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint8" }],
      [specHash, BigInt(closeTime), BigInt(earliestResolve), numOutcomes],
    ),
  );
}

export interface FootballFixture {
  sportKey: string; // e.g. "soccer_epl"
  oddsApiEventId: string;
  sportsDbEventId?: string;
  home: string;
  away: string;
  commenceTime: number; // unix
}

export function footballSpec(f: FootballFixture) {
  return {
    v: 1,
    source: "football",
    league: f.sportKey,
    home: f.home,
    away: f.away,
    kickoff: new Date(f.commenceTime * 1000).toISOString(),
    rule: FOOTBALL_RULE,
    outcomes: ["VOID", "HOME", "AWAY", "DRAW"],
    providers: { theoddsapi: f.oddsApiEventId, thesportsdb: f.sportsDbEventId ?? null },
  };
}

/** Row state 0: planned off-chain by `build`, not on the resolver yet (costs us nothing; the resolver key never signs for it). */
export const Q_PLANNED = 0;

type QuestionRow = typeof questions.$inferInsert;

/** Stores the question spec (state 0) so the public spec URL and a later registration have it. Returns true when new. */
async function planRow(deps: Deps, row: QuestionRow, beforeInsert?: () => Promise<void>): Promise<boolean> {
  await beforeInsert?.();
  const inserted = await deps.db.insert(questions).values({ ...row, state: Q_PLANNED }).onConflictDoNothing().returning({ id: questions.id });
  return inserted.length > 0;
}

/**
 * Registers a planned question on the resolver. The RELAYER key is the resolver's question creator and pays the gas
 * (createQuestion holds no money): the api role sends this and never holds the resolver key, which keeps the bond float
 * and stays worker-only (testnet run 2026-11-02, bug 4). Called only when a funded create is about to be relayed (api
 * `submit` / `prepareQuestion`) or by `ensure*` (tests and tools). Idempotent.
 */
export async function registerPlanned(deps: Deps, id: Hex): Promise<void> {
  const [row] = await deps.db.select().from(questions).where(eq(questions.id, id));
  if (!row) throw new Error("unknown question");
  if (row.state !== Q_PLANNED) return;
  if (row.source === "football") needsTwoSources(deps, (row.providerRefs as Record<string, string | null> | null)?.thesportsdb); // a row planned before audit M-2
  const resolver = required(deps.clients.resolverContract, "RESOLVER_ADDRESS");
  const onchain = await readQuestion(deps, resolver, id);
  if (Number(onchain.state) === 0) {
    if (!deps.clients.relayer) throw new Error("createQuestion failed: the relayer key (the resolver's question creator) is not configured");
    const r = await sendCall(
      deps,
      deps.clients.relayer,
      {
        address: resolver,
        abi: ifsoOutcomeResolverAbi,
        functionName: "createQuestion",
        args: [row.specHash as Hex, BigInt(Math.floor(row.closeTime.getTime() / 1000)), BigInt(Math.floor(row.earliestResolve.getTime() / 1000)), row.numOutcomes, row.specUri],
      },
      { kind: "question-create", questionId: row.id },
    );
    if (!r.ok) throw new Error(`createQuestion failed: ${r.error}`);
    await deps.db.update(questions).set({ state: 1, createdTx: r.hash }).where(and(eq(questions.id, id), eq(questions.state, Q_PLANNED)));
  } else {
    await deps.db.update(questions).set({ state: Number(onchain.state) }).where(and(eq(questions.id, id), eq(questions.state, Q_PLANNED)));
  }
}

export interface PlannedQuestion {
  id: Hex;
  earliestResolve: number;
  closeTime: number;
  /** false when the question was already known (planned or registered): no new row. */
  isNew: boolean;
}

export function footballRow(f: FootballFixture): { row: QuestionRow; closeTime: number; earliest: number } {
  const spec = footballSpec(f);
  const specHash = questionSpecHash(spec);
  const closeTime = f.commenceTime;
  const earliest = f.commenceTime + FOOTBALL_RESOLVE_DELAY;
  const id = questionIdFor(specHash, closeTime, earliest, 3);
  return {
    closeTime,
    earliest,
    row: {
      id,
      source: "football",
      spec,
      specHash,
      specUri: "", // filled by the caller (needs PUBLIC_APP_URL)
      title: `${f.home} vs ${f.away}`,
      home: f.home,
      away: f.away,
      providerRefs: spec.providers,
      closeTime: new Date(closeTime * 1000),
      earliestResolve: new Date(earliest * 1000),
      numOutcomes: 3,
    },
  };
}

/** Plans (no chain write) a league fixture question. */
/** Audit M-2: a football question is only planned when BOTH result sources can be read for it. */
export class FootballRefused extends Error {}
export const FOOTBALL_ONE_SOURCE = "This match can't be checked against two result sources right now, so it can't be used yet. Try again later.";
function needsTwoSources(deps: Deps, sportsDbEventId: string | null | undefined) {
  if (deps.env.SECOND_SPORTS_SOURCE !== "thesportsdb" || !sportsDbEventId) throw new FootballRefused(FOOTBALL_ONE_SOURCE);
}

export async function planFootballQuestion(deps: Deps, f: FootballFixture, beforeInsert?: () => Promise<void>): Promise<PlannedQuestion> {
  // with one source the service can never confirm a result: it never proposes, and every foreign proposal would be
  // "unconfirmed" (disputed only from the bond float at last call). Refuse instead of planning a one-source question.
  needsTwoSources(deps, f.sportsDbEventId);
  const { row, closeTime, earliest } = footballRow(f);
  const [existing] = await deps.db.select({ id: questions.id }).from(questions).where(eq(questions.id, row.id));
  if (existing) return { id: row.id as Hex, earliestResolve: earliest, closeTime, isNew: false };
  row.specUri = `${deps.env.PUBLIC_APP_URL}/q/${row.specHash}.json`;
  await planRow(deps, row, beforeInsert);
  return { id: row.id as Hex, earliestResolve: earliest, closeTime, isNew: true };
}

export async function ensureFootballQuestion(deps: Deps, f: FootballFixture): Promise<{ id: Hex; earliestResolve: number; closeTime: number }> {
  const q = await planFootballQuestion(deps, f);
  await registerPlanned(deps, q.id);
  return q;
}

/** Why a Polymarket market is not allowed for outcome payments (undefined = allowed). Liquidity and volume are what the public API reports. */
export function polymarketRefusal(m: GammaMarket | undefined, env: Pick<Env, "POLYMARKET_MIN_LIQUIDITY_USD" | "POLYMARKET_MIN_VOLUME_USD" | "POLYMARKET_MAX_DAYS_OUT">, nowSec: number): string | undefined {
  if (!m?.endDate || m.closed) return "question not found or already closed";
  if (m.active === false) return "this market is not active";
  let outcomes: string[] = [];
  try {
    outcomes = JSON.parse(m.outcomes) as string[];
  } catch {
    /* falls through */
  }
  if (outcomes.length !== 2 || outcomes[0]?.toLowerCase() !== "yes" || outcomes[1]?.toLowerCase() !== "no") return "only Yes/No markets are supported";
  const close = polymarketCloseTime(m);
  if (close === undefined) return "this market has no usable end date";
  if (close < nowSec + 3600) return "this market ends too soon";
  if (close > nowSec + env.POLYMARKET_MAX_DAYS_OUT * 86400) return `this market ends more than ${env.POLYMARKET_MAX_DAYS_OUT} days from now`;
  if (!(Number(m.liquidityNum) >= env.POLYMARKET_MIN_LIQUIDITY_USD)) return "this market does not have enough liquidity";
  if (!(Number(m.volumeNum) >= env.POLYMARKET_MIN_VOLUME_USD)) return "this market does not have enough trading volume";
  return undefined;
}

/**
 * Close time = the earliest of the market's endDate and its own closedTime. Markets often settle before endDate;
 * the later of the two would leave a challenge open after the answer is known.
 */
export function polymarketCloseTime(m: GammaMarket): number | undefined {
  const times = [m.endDate, m.closedTime]
    .map((x) => (x ? Math.floor(new Date(x).getTime() / 1000) : NaN))
    .filter((x) => Number.isFinite(x) && x > 0);
  return times.length ? Math.min(...times) : undefined;
}

export const YES_PRICE_MIN = 0.02;
export const YES_PRICE_MAX = 0.98;
/** A market already priced outside 2..98% is effectively decided: no challenges on it. */
export function polymarketLooksDecided(m: GammaMarket): boolean {
  try {
    const p = Number((JSON.parse(m.outcomePrices) as string[])[0]);
    return !Number.isFinite(p) || p < YES_PRICE_MIN || p > YES_PRICE_MAX;
  } catch {
    return true;
  }
}

/** Plans (no chain write) a Polymarket question; refuses markets that fail the allow-list. */
export async function planPolymarketQuestion(deps: Deps, slug: string, beforeInsert?: () => Promise<void>): Promise<PlannedQuestion & { market: GammaMarket }> {
  const { market } = await sources(deps).gamma(slug);
  const refusal = polymarketRefusal(market, deps.env, Math.floor(Date.now() / 1000));
  if (refusal || !market) throw new PolymarketRefused(refusal ?? "question not found or already closed");
  const end = polymarketCloseTime(market)!;
  const spec = {
    v: 1,
    source: "polymarket",
    slug,
    conditionId: market.conditionId,
    question: market.question,
    rule: "YES or NO per Polymarket's final resolution. Disputed past expiry, non-binary or split => VOID.",
    outcomes: ["VOID", "YES", "NO"],
  };
  const specHash = questionSpecHash(spec);
  const earliest = end + DEFAULTS.polymarketResolveDelay; // DECISIONS #33: after the expected UMA settlement
  const id = questionIdFor(specHash, end, earliest, 2);
  const [existing] = await deps.db.select({ id: questions.id }).from(questions).where(eq(questions.id, id));
  if (existing) return { id, earliestResolve: earliest, closeTime: end, isNew: false, market };
  await planRow(deps, {
    id,
    source: "polymarket",
    spec,
    specHash,
    specUri: `${deps.env.PUBLIC_APP_URL}/q/${specHash}.json`,
    title: market.question,
    providerRefs: { polymarket: slug, conditionId: market.conditionId },
    closeTime: new Date(end * 1000),
    earliestResolve: new Date(earliest * 1000),
    numOutcomes: 2,
  }, beforeInsert);
  return { id, earliestResolve: earliest, closeTime: end, isNew: true, market };
}

export class PolymarketRefused extends Error {}

export async function ensurePolymarketQuestion(deps: Deps, slug: string): Promise<{ id: Hex; earliestResolve: number; closeTime: number }> {
  const q = await planPolymarketQuestion(deps, slug);
  await registerPlanned(deps, q.id);
  return q;
}

/** Reads every configured source for a question. Failures become "pending" reports (never guesses). */
export async function gatherReports(deps: Deps, q: typeof questions.$inferSelect): Promise<SourceReport[]> {
  const refs = q.providerRefs as Record<string, string | null>;
  const spec = q.spec as Record<string, unknown>;
  const tasks: Promise<SourceReport>[] = [];
  const pending = (provider: string): SourceReport => ({ provider, fetchedAt: Math.floor(Date.now() / 1000), status: "pending", digest: "0x" });
  if (q.source === "football") {
    if (deps.env.ODDS_API_KEY && refs.theoddsapi) {
      tasks.push(sources(deps).oddsScore(deps.env.ODDS_API_KEY, String(spec.league), refs.theoddsapi).catch(() => pending("theoddsapi")));
    }
    if (deps.env.SECOND_SPORTS_SOURCE === "thesportsdb" && refs.thesportsdb) {
      tasks.push(sources(deps).sportsDbEvent(deps.env.THESPORTSDB_KEY, refs.thesportsdb).catch(() => pending("thesportsdb")));
    }
  } else if (q.source === "polymarket") {
    tasks.push(sources(deps).gamma(String(refs.polymarket)).then((r) => r.report).catch(() => pending("polymarket-gamma")));
    if (deps.env.POLYGON_RPC_URL && refs.conditionId) {
      tasks.push(sources(deps).ctf(deps.env.POLYGON_RPC_URL, refs.conditionId as Hex).catch(() => pending("polygon-ctf")));
    }
  }
  const fresh = await Promise.all(tasks);
  if (fresh.length) {
    await deps.db.insert(sourceReports).values(
      fresh.map((r) => ({ questionId: q.id, provider: r.provider, fetchedAt: new Date(r.fetchedAt * 1000), status: r.status, outcome: r.outcome, digest: r.digest })),
    );
  }
  return holdLatestFinals(deps, q.id, fresh);
}

/**
 * Audit L-7 / L-8: a provider's LATEST final read for a question is kept. A later pending read from that provider (The
 * Odds API's /scores drops a finished game after 3 days, and any outage or missing event reads as pending) is replaced
 * by the newest stored final, so a met payment is not refunded because a source forgot the game, and a corrected result
 * (final A, then final B) never falls back to the superseded A. A fresh final or void read is a real answer and is used
 * as read (a contradiction then shows up as a conflict, never as a silent change).
 */
async function holdLatestFinals(deps: Deps, questionId: string, fresh: SourceReport[]): Promise<SourceReport[]> {
  if (!fresh.some((r) => r.status === "pending")) return fresh;
  const stored = await deps.db
    .select()
    .from(sourceReports)
    .where(and(eq(sourceReports.questionId, questionId), eq(sourceReports.status, "final")))
    .orderBy(desc(sourceReports.fetchedAt), desc(sourceReports.id));
  const latest = new Map<string, SourceReport>();
  for (const r of stored) {
    if (latest.has(r.provider) || r.outcome === null) continue;
    latest.set(r.provider, { provider: r.provider, fetchedAt: Math.floor(r.fetchedAt.getTime() / 1000), status: "final", outcome: r.outcome, digest: r.digest as Hex });
  }
  return fresh.map((r) => (r.status === "pending" ? (latest.get(r.provider) ?? r) : r));
}

async function ensureBondAllowance(deps: Deps, resolver: Address) {
  const wallet = deps.clients.resolver;
  if (!wallet?.account) return;
  const allowance = await deps.clients.publicClient.readContract({ address: deps.clients.usdg, abi: usdgAbi, functionName: "allowance", args: [wallet.account.address, resolver] });
  if (allowance < 10n ** 12n) {
    await sendCall(deps, wallet, { address: deps.clients.usdg, abi: usdgAbi, functionName: "approve", args: [resolver, maxUint256] }, { kind: "bond-approve" });
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";
/** Causes already raised by this process. The alert sender also dedupes (30 min), this keeps a restart-free loop quiet. */
const raised = new Set<string>();
export const resetResolverAlerts = () => (raised.clear(), pastWindow.clear());
async function raiseOnce(deps: Deps, cause: string, text: string) {
  if (raised.has(cause)) return;
  raised.add(cause);
  await raise(deps, cause, text);
}

/** True (and an alert) when the resolver key cannot post `need` USDG: a missing key or a short bond float. */
async function bondShort(deps: Deps, need: bigint, what: string): Promise<boolean> {
  const wallet = deps.clients.resolver;
  if (!wallet?.account) {
    await raiseOnce(deps, "resolver-no-key", `resolver key not configured: ${what}`);
    return true;
  }
  const bal = await deps.clients.publicClient.readContract({ address: deps.clients.usdg, abi: usdgAbi, functionName: "balanceOf", args: [wallet.account.address] });
  if (bal >= need) return false;
  await raise(deps, "resolver-bond-short", `resolver USDG bond float ${bal} is below the ${need} bond needed: ${what}. Top up the resolver address ${wallet.account.address}`);
  return true;
}

type OnchainQuestion = Awaited<ReturnType<typeof readQuestion>>;
function readQuestion(deps: Deps, resolver: Address, id: Hex) {
  return deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "getQuestion", args: [id] });
}

/** Mirrors the on-chain record into the questions row (state, proposal, dispute time, final outcome). */
async function syncRow(deps: Deps, resolver: Address, id: Hex): Promise<OnchainQuestion> {
  const o = await readQuestion(deps, resolver, id);
  const state = Number(o.state);
  if (state === 4 || state === 5) questionSettled(id); // FINAL / VOID: the keeper settles its payments on its next tick
  await deps.db
    .update(questions)
    .set({
      state,
      proposedOutcome: state >= 2 ? o.proposed : null,
      proposer: o.proposer === ZERO ? null : o.proposer,
      finalOutcome: state === 4 ? o.finalOutcome : null,
      disputedAt: o.disputedAt > 0n ? new Date(Number(o.disputedAt) * 1000) : null,
    })
    .where(eq(questions.id, id));
  return o;
}

const CURSOR = "resolver";
/** Foreign proposals handled per tick ahead of the cursor page (each one is disputed or confirmed in one visit). */
const FOREIGN_PAGE = 200;
/** Foreign proposals whose window closed unconfirmed: nothing left to dispute, so they do not hold foreign-pass slots. */
const pastWindow = new Set<string>();
async function readCursor(deps: Deps): Promise<{ at: Date; id: string } | undefined> {
  const [c] = await deps.db.select().from(cursors).where(eq(cursors.name, CURSOR));
  return c?.hash ? { at: new Date(Number(c.block) * 1000), id: c.hash } : undefined;
}
async function writeCursor(deps: Deps, last: { earliestResolve: Date; id: string } | undefined) {
  if (!last) {
    await deps.db.delete(cursors).where(eq(cursors.name, CURSOR));
    return;
  }
  const v = { name: CURSOR, block: BigInt(Math.floor(last.earliestResolve.getTime() / 1000)), hash: last.id };
  await deps.db.insert(cursors).values(v).onConflictDoUpdate({ target: cursors.name, set: { block: v.block, hash: v.hash } });
}

/** Minimum ticks inside the last-call slot (one tick a minute in main.ts) plus inclusion time. */
const RESOLVER_TICK_SEC = 60;
export function assertLastCall(lastCall: number, disputeWindow: number): number {
  if (!(lastCall >= 4 * RESOLVER_TICK_SEC)) throw new Error(`RESOLVER_LAST_CALL_SECONDS=${lastCall} leaves fewer than 4 resolver ticks to dispute in`);
  if (!(lastCall < disputeWindow / 2)) throw new Error(`RESOLVER_LAST_CALL_SECONDS=${lastCall} must be under half the ${disputeWindow} s dispute window`);
  return lastCall;
}

/**
 * Review R3-H1: one decision per tick over every open foreign proposal (see core/disputePolicy.ts), then the calls.
 * Never finalizes anything: an unconfirmed proposal that reaches the end of its window raises an alert in resolveOne.
 */
async function actOnForeign(deps: Deps, resolver: Address, candidates: Foreign[], now: number, lastCall: number) {
  const open = candidates.filter((c) => c.verdict !== "confirmed");
  for (const c of candidates.filter((c) => c.verdict === "confirmed")) deps.log("foreign proposal confirmed by our sources", { q: c.id, proposed: c.proposed });
  if (!open.length) return;
  const wallet = deps.clients.resolver;
  if (!wallet?.account) {
    await raiseOnce(deps, "resolver-no-key", `resolver key not configured: cannot dispute ${open.length} unconfirmed proposal(s)`);
    return;
  }
  const amounts = await deps.db
    .select({ id: escrows.questionId, total: sql<string>`sum(${escrows.amount} + ${escrows.counterAmount})` })
    .from(escrows)
    .where(and(inArray(escrows.questionId, open.map((c) => c.id)), inArray(escrows.status, [1, 2])))
    .groupBy(escrows.questionId);
  const atRisk = new Map(amounts.map((r) => [String(r.id), BigInt(String(r.total ?? "0").split(".")[0] || "0")]));
  for (const c of candidates) c.atRisk = atRisk.get(c.id) ?? 0n;
  const bondNow = await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "bondAmount" });
  const bond = open.reduce((m, c) => (c.bond > m ? c.bond : m), bondNow);
  const balance = await deps.clients.publicClient.readContract({ address: deps.clients.usdg, abi: usdgAbi, functionName: "balanceOf", args: [wallet.account.address] });
  const [{ n: openLastCall } = { n: 0 }] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(questions).where(and(eq(questions.disputeKind, "last-call"), eq(questions.state, 3)));
  const actions = planForeignDisputes({ now, lastCall, bond, balance, budgetCap: deps.env.RESOLVER_UNCONFIRMED_DISPUTE_BUDGET, openLastCall: Number(openLastCall), candidates: open });
  const byId = new Map(open.map((c) => [c.id, c]));
  let approved = false;
  for (const act of actions) {
    const c = byId.get(act.id)!;
    const closes = new Date(c.closesAt * 1000).toISOString();
    const why = c.agreement.decision !== null ? `our sources say ${c.agreement.decision}` : c.agreement.conflict ? "our sources contradict each other" : `our sources cannot confirm it yet (${c.agreement.reason})`;
    if (act.do === "wait") deps.log("foreign proposal not confirmed yet, re-checking", { q: c.id, proposed: c.proposed, why, lastCallFrom: new Date((c.closesAt - lastCall) * 1000).toISOString() });
    else if (act.do === "short") await raise(deps, "resolver-bond-short", `resolver USDG bond float ${balance} is below the ${bond} bond needed to dispute the contradicted proposal (outcome ${c.proposed}) on question ${c.id} before ${closes}; ${why}. Top up the resolver address ${wallet.account.address} or dispute from the panel runbook`);
    else if (act.do === "page") {
      const reason = act.reason === "budget" ? `the open last-call dispute budget (${deps.env.RESOLVER_UNCONFIRMED_DISPUTE_BUDGET}) is used up` : `the float (${balance}) must keep one ${bond} bond for a contradicted proposal`;
      await raiseOnce(deps, `resolver-dispute-budget:${c.id}:${c.proposedAt}`, `unconfirmed proposal (outcome ${c.proposed}) by ${c.proposer} on question ${c.id}, ${c.atRisk} USDG units in payments, window closes ${closes}: not disputed because ${reason}; ${why}. A human must dispute it from the panel runbook before the window closes`);
    } else if (act.do === "dispute") {
      if (!approved) await ensureBondAllowance(deps, resolver);
      approved = true;
      deps.log("disputing foreign proposal", { q: c.id, proposed: c.proposed, kind: act.kind, why });
      const r = await sendCall(deps, wallet, { address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "dispute", args: [c.id as Hex, c.agreement.sourcesHash] } as never, { kind: "dispute", questionId: c.id });
      if (r.ok) {
        await syncRow(deps, resolver, c.id as Hex);
        await deps.db.update(questions).set({ disputeKind: act.kind }).where(eq(questions.id, c.id));
      } else await raiseOnce(deps, `resolver-dispute-failed:${c.id}:${c.proposedAt}`, `dispute (${act.kind}) of the proposal on question ${c.id} failed (${r.error ?? "reverted"}); ${why}; the window closes ${closes}`);
    }
  }
}

/**
 * Audit M-1: panel silence (finalizeTimedOut) now gives each side only floor(bond / 2) back; the other halves go to
 * the FeeRouter. When the service was one of the two sides, its float shrank by the forfeited half: say so. The
 * worst case per open dispute is still one bond (a last-call dispute the panel upholds), so the dispute budget
 * (`floor(float / bond) - 1`, recomputed from the live balance every tick) stays solvent; silence is a panel failure.
 */
async function panelSilentCost(deps: Deps, id: string, o: { proposer: string; disputer: string; bond: bigint }, me: string | undefined) {
  if (!me) return;
  const sides = [o.proposer, o.disputer].filter((a) => a.toLowerCase() === me).length;
  if (!sides) return;
  const lost = (o.bond - o.bond / 2n) * BigInt(sides);
  await raiseOnce(deps, `resolver-panel-silent:${id}`, `the panel did not answer the dispute on question ${id} in its window, so it is VOID and the payments on it refund; the service got only half its bond back and the float shrank by ${lost} USDG units (forfeited to the FeeRouter). Check the panel signers`);
}

/** Last-call disputes the panel settled: one the panel upheld cost the float a bond (half to the proposer, half to the FeeRouter), so say so. */
async function lastCallResults(deps: Deps, resolver: Address) {
  const rows = await deps.db.select({ id: questions.id }).from(questions).where(eq(questions.disputeKind, "last-call")).limit(200);
  for (const { id } of rows) {
    const o = await syncRow(deps, resolver, id as Hex);
    const state = Number(o.state);
    if (state < 4) continue;
    if (state === 5) await panelSilentCost(deps, id, o, deps.clients.resolver?.account?.address?.toLowerCase()); // voided by anyone
    if (state === 4 && o.finalOutcome === o.proposed) {
      await raiseOnce(deps, `resolver-last-call-lost:${id}`, `the panel upheld the proposal (outcome ${o.proposed}) on question ${id} that the service disputed at last call; the float shrank by one bond (audit M-1: half of it went to the proposer, the other half to the FeeRouter)`);
    }
    await deps.db.update(questions).set({ disputeKind: "last-call-done" }).where(and(eq(questions.id, id), eq(questions.disputeKind, "last-call")));
  }
}

export async function resolverTick(deps: Deps, pageSize = 100) {
  const resolver = required(deps.clients.resolverContract, "RESOLVER_ADDRESS");
  const me = deps.clients.resolver?.account?.address?.toLowerCase();
  const now = Number(await chainNow(deps)); // the contract judges windows by block time, so do we
  const disputeWindow = Number(await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "disputeWindow" }));
  const panelWindow = Number(await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "panelWindow" }));
  const lastCall = assertLastCall(deps.env.RESOLVER_LAST_CALL_SECONDS, disputeWindow);

  // Only questions that have at least one funded (OPEN or MET) escrow are worth a bond. Oldest earliestResolve first,
  // walking a cursor so questions that stay undecided for days cannot starve the ones behind them.
  const fundedEscrow = exists(deps.db.select({ one: sql`1` }).from(escrows).where(and(eq(escrows.questionId, questions.id), inArray(escrows.status, [1, 2]))));
  const cur = await readCursor(deps);
  const PAGE = pageSize;
  const page = (after: ReturnType<typeof or> | undefined) =>
    deps.db
      .select()
      .from(questions)
      .where(and(inArray(questions.state, [1, 2, 3]), lte(questions.earliestResolve, new Date(now * 1000)), fundedEscrow, after))
      .orderBy(asc(questions.earliestResolve), asc(questions.id))
      .limit(PAGE);
  let live = cur ? await page(or(gt(questions.earliestResolve, cur.at), and(eq(questions.earliestResolve, cur.at), gt(questions.id, cur.id)))) : [];
  if (!live.length) live = await page(undefined); // end of the walk (or no cursor yet): start again from the oldest
  await writeCursor(deps, live.length < PAGE ? undefined : live[live.length - 1]);

  // planned questions nobody ever funded are dropped once their close time passed
  await deps.db.delete(questions).where(and(eq(questions.state, Q_PLANNED), lt(questions.closeTime, new Date(now * 1000))));

  // Review R2-H1: proposals by other addresses are checked first, every tick, whatever the cursor page holds, so a
  // long backlog of undecided questions cannot push one past its 2 h dispute window. The indexer marks them state 2.
  const foreign = await deps.db
    .select()
    .from(questions)
    .where(and(eq(questions.state, 2), me ? sql`lower(coalesce(${questions.proposer}, '')) <> ${me}` : undefined, pastWindow.size ? notInArray(questions.id, [...pastWindow]) : undefined, fundedEscrow))
    .orderBy(asc(questions.earliestResolve), asc(questions.id))
    .limit(FOREIGN_PAGE);
  const seen = new Set(foreign.map((q) => q.id));
  const candidates: Foreign[] = [];
  for (const q of [...foreign, ...live.filter((q) => !seen.has(q.id))]) {
    try {
      const c = await resolveOne(deps, resolver, me, q, now, disputeWindow, panelWindow);
      if (c) candidates.push(c);
    } catch (e) {
      deps.log("resolver error", { q: q.id, error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }
  try {
    await actOnForeign(deps, resolver, candidates, now, lastCall);
  } catch (e) {
    deps.log("resolver error", { step: "foreign disputes", error: String((e as Error)?.message ?? e).slice(0, 300) });
    for (const c of candidates) if (c.verdict !== "confirmed") await raiseOnce(deps, `resolver-foreign-error:${c.id}:${c.proposedAt}`, `the dispute check for the proposal on question ${c.id} failed (${String((e as Error)?.message ?? e).slice(0, 120)}); the window closes ${new Date(c.closesAt * 1000).toISOString()}, needs a human look`);
  }
  await lastCallResults(deps, resolver).catch((e) => deps.log("resolver error", { step: "last-call results", error: String((e as Error)?.message ?? e).slice(0, 300) }));

  // pull back any credited bonds
  if (me) {
    const claimable = await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "claimableBond", args: [me as Address] });
    if (claimable > 0n) await sendCall(deps, deps.clients.resolver, { address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "withdrawBond", args: [ZERO] }, { kind: "bond-withdraw" });
  }
}

type Foreign = ForeignCandidate & { proposed: number; proposer: string; proposedAt: number; bond: bigint; agreement: Agreement };

async function resolveOne(deps: Deps, resolver: Address, me: string | undefined, q: typeof questions.$inferSelect, now: number, disputeWindow: number, panelWindow: number): Promise<Foreign | undefined> {
  const id = q.id as Hex;
  const onchain = await syncRow(deps, resolver, id);
  const state = Number(onchain.state);
  const call = (functionName: "propose" | "dispute" | "finalize" | "finalizeTimedOut", args: readonly unknown[], wallet = deps.clients.resolver) =>
    sendCall(deps, wallet, { address: resolver, abi: ifsoOutcomeResolverAbi, functionName, args } as never, { kind: functionName, questionId: q.id });

  if (state === 1) {
    const a = agree(await gatherReports(deps, q));
    deps.log("agreement", { q: q.id, decision: a.decision, reason: a.reason, providers: a.providers });
    if (a.decision === null) {
      if (a.conflict) await raiseOnce(deps, `resolver-conflict:${q.id}`, `sources contradict each other for question ${q.id} (${a.providers.join(", ")}); no proposal made, needs a human look`);
      else if (now > Math.floor(q.earliestResolve.getTime() / 1000) + 48 * 3600) await raiseOnce(deps, `resolver-unresolved:${q.id}`, `question ${q.id} still has no agreed result 48 hours after the earliest resolve time; the payments on it refund at expiry`);
      return;
    }
    const bond = await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "bondAmount" });
    if (await bondShort(deps, bond, `cannot propose the agreed result on question ${q.id}`)) return;
    await ensureBondAllowance(deps, resolver);
    const r = await call("propose", [id, a.decision, a.sourcesHash]);
    if (r.ok) await syncRow(deps, resolver, id);
  } else if (state === 2) {
    const proposedAt = Number(onchain.proposedAt);
    const closesAt = proposedAt + disputeWindow;
    const foreign = onchain.proposer.toLowerCase() !== me;
    if (foreign && now < closesAt) {
      // Review R3-H1 (DECISIONS #32): the proposal is classified here and acted on for the whole tick at once by
      // `planForeignDisputes` (contradicted: dispute now; unconfirmed: re-check every tick, dispute only in the
      // last-call slot within the bond budget; confirmed: leave it).
      await raiseOnce(deps, `resolver-foreign:${q.id}:${proposedAt}`, `another address (${onchain.proposer}) proposed outcome ${onchain.proposed} on question ${q.id}; the window closes ${new Date(closesAt * 1000).toISOString()}`);
      const reports = await gatherReports(deps, q);
      const a = agree(reports);
      return { id: q.id, verdict: classifyForeign(a, onchain.proposed, reports), closesAt, atRisk: 0n, proposed: onchain.proposed, proposer: onchain.proposer, proposedAt, bond: onchain.bond, agreement: a };
    } else if (now >= closesAt) {
      if (foreign) {
        // Never finalize a proposal we did not confirm (anyone else still can: that is why the dispute above matters).
        const a = agree(await gatherReports(deps, q));
        if (a.decision === null || a.decision !== onchain.proposed) {
          pastWindow.add(q.id); // stays in the cursor walk, leaves the per-tick foreign pass
          await raiseOnce(deps, `resolver-unconfirmed-open:${q.id}:${proposedAt}`, `the window on question ${q.id} closed with an undisputed proposal (outcome ${onchain.proposed}) by ${onchain.proposer} that our sources do not confirm; the service will not finalize it, needs a human look`);
          return;
        }
      }
      const r = await call("finalize", [id], deps.clients.resolver ?? deps.clients.keeper);
      if (r.ok) await syncRow(deps, resolver, id);
    }
  } else if (state === 3) {
    const deadline = Number(onchain.disputedAt) + panelWindow;
    if (now >= deadline) {
      const r = await call("finalizeTimedOut", [id], deps.clients.resolver ?? deps.clients.keeper);
      if (r.ok) {
        await syncRow(deps, resolver, id);
        await panelSilentCost(deps, q.id, onchain, me);
      }
    } else {
      await raiseOnce(deps, `panel-waiting:${q.id}`, `question ${q.id} is disputed and waits on the panel until ${new Date(deadline * 1000).toISOString()}; no answer by then voids it, the payments on it refund and each side gets only half its bond back (the other halves go to the FeeRouter)`);
    }
  }
}
