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
import * as oddsApi from "../sources/theOddsApi";
import * as sportsDb from "../sources/theSportsDb";
import * as polymarket from "../sources/polymarket";
import { sendCall } from "./tx";
import type { Deps } from "./deps";

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
  const { market } = await polymarket.fetchGamma(slug);
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
      tasks.push(oddsApi.fetchScore(deps.env.ODDS_API_KEY, String(spec.league), refs.theoddsapi).catch(() => pending("theoddsapi")));
    }
    if (deps.env.SECOND_SPORTS_SOURCE === "thesportsdb" && refs.thesportsdb) {
      tasks.push(sportsDb.fetchEvent(deps.env.THESPORTSDB_KEY, refs.thesportsdb).catch(() => pending("thesportsdb")));
    }
  } else if (q.source === "polymarket") {
    tasks.push(polymarket.fetchGamma(String(refs.polymarket)).then((r) => r.report).catch(() => pending("polymarket-gamma")));
    if (deps.env.POLYGON_RPC_URL && refs.conditionId) {
      tasks.push(polymarket.fetchCtf(deps.env.POLYGON_RPC_URL, refs.conditionId as Hex).catch(() => pending("polygon-ctf")));
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

export async function resolverTick(deps: Deps) {
  const resolver = required(deps.clients.resolverContract, "RESOLVER_ADDRESS");
  const me = deps.clients.resolver?.account?.address?.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const disputeWindow = Number(await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "disputeWindow" }));
  const panelWindow = Number(await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "panelWindow" }));

  const live = await deps.db
    .select()
    .from(questions)
    .where(and(inArray(questions.state, [1, 2, 3]), lte(questions.earliestResolve, new Date(now * 1000))))
    .limit(100);

  for (const q of live) {
    const onchain = await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "getQuestion", args: [q.id as Hex] });
    const state = Number(onchain.state);
    if (state !== q.state) await deps.db.update(questions).set({ state, proposedOutcome: onchain.proposed, proposer: onchain.proposer, finalOutcome: state === 4 ? onchain.finalOutcome : null }).where(eq(questions.id, q.id));

    if (state === 1) {
      const a = agree(await gatherReports(deps, q));
      deps.log("agreement", { q: q.id, decision: a.decision, reason: a.reason, providers: a.providers });
      if (a.decision === null) {
        if (now > Math.floor(q.earliestResolve.getTime() / 1000) + 48 * 3600) deps.log("ALERT unresolved after 48h: escrows will refund at expiry", { q: q.id });
        continue;
      }
      await ensureBondAllowance(deps, resolver);
      await sendCall(deps, deps.clients.resolver, { address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "propose", args: [q.id as Hex, a.decision, a.sourcesHash] }, { kind: "propose", questionId: q.id });
    } else if (state === 2) {
      const proposedAt = Number(onchain.proposedAt);
      if (onchain.proposer.toLowerCase() !== me && now < proposedAt + disputeWindow) {
        // someone else proposed: check it against our own sources
        const a = agree(await gatherReports(deps, q));
        if (a.decision !== null && a.decision !== onchain.proposed) {
          deps.log("disputing contradicting proposal", { q: q.id, proposed: onchain.proposed, ours: a.decision });
          await ensureBondAllowance(deps, resolver);
          await sendCall(deps, deps.clients.resolver, { address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "dispute", args: [q.id as Hex, a.sourcesHash] }, { kind: "dispute", questionId: q.id });
        }
      } else if (now >= proposedAt + disputeWindow) {
        await sendCall(deps, deps.clients.resolver ?? deps.clients.keeper, { address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "finalize", args: [q.id as Hex] }, { kind: "finalize", questionId: q.id });
      }
    } else if (state === 3) {
      if (now >= Number(onchain.disputedAt) + panelWindow) {
        await sendCall(deps, deps.clients.resolver ?? deps.clients.keeper, { address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "finalizeTimedOut", args: [q.id as Hex] }, { kind: "panel-timeout", questionId: q.id });
      } else {
        deps.log("ALERT disputed question waiting on the panel", { q: q.id, deadline: Number(onchain.disputedAt) + panelWindow });
      }
    }
  }

  // pull back any credited bonds
  if (me) {
    const claimable = await deps.clients.publicClient.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "claimableBond", args: [me as Address] });
    if (claimable > 0n) await sendCall(deps, deps.clients.resolver, { address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "withdrawBond", args: ["0x0000000000000000000000000000000000000000"] }, { kind: "bond-withdraw" });
  }
}
