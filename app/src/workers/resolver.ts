// Outcome resolver service for IfsoOutcomeResolver (studio-run, bonded, optimistic).
//  - registers questions lazily, the first time someone builds a payment on a fixture / Polymarket question
//  - after earliestResolve: reads >= 2 independent sources, proposes only on agreement (USDG bond)
//  - watches proposals made by anyone else and disputes the ones its sources contradict
//  - finalizes undisputed proposals after the window; times out silent panels (=> VOID => refunds)
import { and, eq, inArray, lte } from "drizzle-orm";
import { encodeAbiParameters, keccak256, maxUint256, type Address, type Hex } from "viem";
import { ifsoOutcomeResolverAbi, usdgAbi } from "../abi";
import { agree, questionSpecHash, type SourceReport } from "../core/outcome";
import { questions, sourceReports } from "../db/schema";
import { required } from "../chain";
import { liveSources } from "../sources";
import { chainNow } from "./keeper";
import { sendCall } from "./tx";
import { raise, type Deps } from "./deps";

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

async function registerOnChain(deps: Deps, row: typeof questions.$inferInsert, closeTime: number, earliest: number) {
  const resolver = required(deps.clients.resolverContract, "RESOLVER_ADDRESS");
  const r = await sendCall(
    deps,
    deps.clients.resolver,
    {
      address: resolver,
      abi: ifsoOutcomeResolverAbi,
      functionName: "createQuestion",
      args: [row.specHash as Hex, BigInt(closeTime), BigInt(earliest), row.numOutcomes, row.specUri],
    },
    { kind: "question-create", questionId: row.id },
  );
  if (!r.ok) throw new Error(`createQuestion failed: ${r.error}`);
  await deps.db.insert(questions).values({ ...row, createdTx: r.hash }).onConflictDoNothing();
}

export async function ensureFootballQuestion(deps: Deps, f: FootballFixture): Promise<{ id: Hex; earliestResolve: number; closeTime: number }> {
  const spec = footballSpec(f);
  const specHash = questionSpecHash(spec);
  const closeTime = f.commenceTime;
  const earliest = f.commenceTime + FOOTBALL_RESOLVE_DELAY;
  const id = questionIdFor(specHash, closeTime, earliest, 3);
  const existing = await deps.db.select({ id: questions.id }).from(questions).where(eq(questions.id, id));
  if (!existing.length) {
    await registerOnChain(
      deps,
      {
        id,
        source: "football",
        spec,
        specHash,
        specUri: `${deps.env.PUBLIC_APP_URL}/q/${specHash}.json`,
        title: `${f.home} vs ${f.away}`,
        home: f.home,
        away: f.away,
        providerRefs: spec.providers,
        closeTime: new Date(closeTime * 1000),
        earliestResolve: new Date(earliest * 1000),
        numOutcomes: 3,
      },
      closeTime,
      earliest,
    );
  }
  return { id, earliestResolve: earliest, closeTime };
}

export async function ensurePolymarketQuestion(deps: Deps, slug: string): Promise<{ id: Hex; earliestResolve: number; closeTime: number }> {
  const { market } = await sources(deps).gamma(slug);
  if (!market?.endDate || market.closed) throw new Error("question not found or already closed");
  const end = Math.floor(new Date(market.endDate).getTime() / 1000);
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
  const id = questionIdFor(specHash, end, end, 2);
  const existing = await deps.db.select({ id: questions.id }).from(questions).where(eq(questions.id, id));
  if (!existing.length) {
    await registerOnChain(
      deps,
      {
        id,
        source: "polymarket",
        spec,
        specHash,
        specUri: `${deps.env.PUBLIC_APP_URL}/q/${specHash}.json`,
        title: market.question,
        providerRefs: { polymarket: slug, conditionId: market.conditionId },
        closeTime: new Date(end * 1000),
        earliestResolve: new Date(end * 1000),
        numOutcomes: 2,
      },
      end,
      end,
    );
  }
  return { id, earliestResolve: end, closeTime: end };
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
  const reports = await Promise.all(tasks);
  if (reports.length) {
    await deps.db.insert(sourceReports).values(
      reports.map((r) => ({ questionId: q.id, provider: r.provider, fetchedAt: new Date(r.fetchedAt * 1000), status: r.status, outcome: r.outcome, digest: r.digest })),
    );
  }
  return reports;
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
export const resetResolverAlerts = () => raised.clear();
async function raiseOnce(deps: Deps, cause: string, text: string) {
  if (raised.has(cause)) return;
  raised.add(cause);
  await raise(deps, cause, text);
}

type OnchainQuestion = Awaited<ReturnType<typeof readQuestion>>;
function readQuestion(deps: Deps, resolver: Address, id: Hex) {
  return deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "getQuestion", args: [id] });
}

/** Mirrors the on-chain record into the questions row (state, proposal, dispute time, final outcome). */
async function syncRow(deps: Deps, resolver: Address, id: Hex): Promise<OnchainQuestion> {
  const o = await readQuestion(deps, resolver, id);
  const state = Number(o.state);
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

export async function resolverTick(deps: Deps) {
  const resolver = required(deps.clients.resolverContract, "RESOLVER_ADDRESS");
  const me = deps.clients.resolver?.account?.address?.toLowerCase();
  const now = Number(await chainNow(deps)); // the contract judges windows by block time, so do we
  const disputeWindow = Number(await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "disputeWindow" }));
  const panelWindow = Number(await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "panelWindow" }));

  const live = await deps.db
    .select()
    .from(questions)
    .where(and(inArray(questions.state, [1, 2, 3]), lte(questions.earliestResolve, new Date(now * 1000))))
    .limit(100);

  for (const q of live) {
    try {
      await resolveOne(deps, resolver, me, q, now, disputeWindow, panelWindow);
    } catch (e) {
      deps.log("resolver error", { q: q.id, error: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }

  // pull back any credited bonds
  if (me) {
    const claimable = await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "claimableBond", args: [me as Address] });
    if (claimable > 0n) await sendCall(deps, deps.clients.resolver, { address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "withdrawBond", args: [ZERO] }, { kind: "bond-withdraw" });
  }
}

async function resolveOne(deps: Deps, resolver: Address, me: string | undefined, q: typeof questions.$inferSelect, now: number, disputeWindow: number, panelWindow: number) {
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
    await ensureBondAllowance(deps, resolver);
    const r = await call("propose", [id, a.decision, a.sourcesHash]);
    if (r.ok) await syncRow(deps, resolver, id);
  } else if (state === 2) {
    const proposedAt = Number(onchain.proposedAt);
    if (onchain.proposer.toLowerCase() !== me && now < proposedAt + disputeWindow) {
      // someone else proposed: check it against our own sources
      const a = agree(await gatherReports(deps, q));
      if (a.decision !== null && a.decision !== onchain.proposed) {
        deps.log("disputing contradicting proposal", { q: q.id, proposed: onchain.proposed, ours: a.decision });
        await ensureBondAllowance(deps, resolver);
        const r = await call("dispute", [id, a.sourcesHash]);
        if (r.ok) await syncRow(deps, resolver, id);
      } else if (a.conflict) {
        await raiseOnce(deps, `resolver-conflict:${q.id}`, `a proposal by another address on question ${q.id} cannot be checked: our sources contradict each other; it was not disputed`);
      }
    } else if (now >= proposedAt + disputeWindow) {
      const r = await call("finalize", [id], deps.clients.resolver ?? deps.clients.keeper);
      if (r.ok) await syncRow(deps, resolver, id);
    }
  } else if (state === 3) {
    const deadline = Number(onchain.disputedAt) + panelWindow;
    if (now >= deadline) {
      const r = await call("finalizeTimedOut", [id], deps.clients.resolver ?? deps.clients.keeper);
      if (r.ok) await syncRow(deps, resolver, id);
    } else {
      await raiseOnce(deps, `panel-waiting:${q.id}`, `question ${q.id} is disputed and waits on the panel until ${new Date(deadline * 1000).toISOString()}; no answer by then voids it and the payments on it refund`);
    }
  }
}
