// Shared setup for the resolver tests on anvil + Postgres: the resolver key is a registered question creator and
// holds a USDG bond float; provider reads come from recorded fixtures; ops alerts are captured.
import { privateKeyToAccount } from "viem/accounts";
import { ifsoOutcomeResolverAbi } from "../../src/abi";
import type { Abi, Hex } from "viem";
import { questions } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { ensureFootballQuestion, resetResolverAlerts, type FootballFixture } from "../../src/workers/resolver";
import type { Deps } from "../../src/workers/deps";
import { bootChain, bootDb, makeTestDeps, type TestChain, type TestDb } from "./chain";
import { eplEvents, fixtureSources, oddsScores, type FixtureOverrides } from "./resolverFixtures";

export interface ResolverEnv {
  chain: TestChain;
  pg: TestDb;
  deps: Deps;
  alerts: Array<[string, string]>;
  logs: string[];
  resolverAddress: `0x${string}`;
  setSources(o?: FixtureOverrides): void;
  /** Register fixture #i (TheSportsDB idEvent / synthetic Odds API id) as a question kicking off `inSec` from now. */
  question(i: number, inSec?: number): Promise<{ id: Hex; earliestResolve: number; closeTime: number; fixture: FootballFixture }>;
  stop(): Promise<void>;
}

export async function bootResolverEnv(): Promise<ResolverEnv> {
  resetResolverAlerts();
  const chain = await bootChain();
  const pg = await bootDb();
  const me = privateKeyToAccount(chain.resolverKey).address;
  await chain.write(chain.deployer, chain.resolver, ifsoOutcomeResolverAbi as Abi, "setCreator", [me, true]);
  await chain.mint(me, 1000);
  const alerts: Array<[string, string]> = [];
  const logs: string[] = [];
  const deps: Deps = {
    ...makeTestDeps(chain, pg.db, { ODDS_API_KEY: "test-key", POLYGON_RPC_URL: "http://127.0.0.1:1" }, (m) => void logs.push(m)),
    alert: async (cause, text) => (alerts.push([cause, text]), true),
    sources: fixtureSources(),
  };
  return {
    chain,
    pg,
    deps,
    alerts,
    logs,
    resolverAddress: me,
    setSources(o) {
      deps.sources = fixtureSources(o);
    },
    async question(i, inSec = 3600) {
      const e = eplEvents[i]!;
      const odds = oddsScores.find((s) => s._derivedFrom === e.idEvent)!;
      const fixture: FootballFixture = {
        sportKey: "soccer_epl",
        oddsApiEventId: odds.id,
        sportsDbEventId: e.idEvent,
        home: e.strHomeTeam,
        away: e.strAwayTeam,
        commenceTime: Number(await chain.now()) + inSec,
      };
      const q = await ensureFootballQuestion(deps, fixture);
      return { ...q, fixture };
    },
    async stop() {
      chain.stop();
      await pg.stop();
    },
  };
}

export const rowOf = async (env: ResolverEnv, id: string) => (await env.pg.db.select().from(questions).where(eq(questions.id, id)))[0]!;
export const onchainState = async (env: ResolverEnv, id: Hex) =>
  (await env.chain.pc.readContract({ address: env.chain.resolver, abi: ifsoOutcomeResolverAbi, functionName: "outcomeOf", args: [id] })) as readonly [number, number];

import { Kind, emptyCondition, Status } from "../../src/core/types";
import { ifsoEscrowAbi } from "../../src/abi";

/** An OUTCOME escrow on `questionId` that unlocks when outcome 1 (HOME / YES) is the final answer. */
export async function createOutcomeEscrow(env: ResolverEnv, questionId: Hex, expiry: bigint, mask = 2n) {
  return env.chain.create(env.chain.sender, {
    condition: { ...emptyCondition(), kind: Kind.OUTCOME, target: env.chain.resolver, key: questionId, outcomeMask: mask },
    expiry,
  });
}

export const escrowStatus = async (env: ResolverEnv, id: bigint) =>
  Number(((await env.chain.pc.readContract({ address: env.chain.escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [id] })) as { status: number }).status);

export { Status };

import { usdgAbi } from "../../src/abi";
/** Another address posts a bonded proposal on the resolver contract (not the service). */
export async function proposeAs(env: ResolverEnv, who: import("viem/accounts").PrivateKeyAccount, id: Hex, outcome: number) {
  await env.chain.mint(who.address, 20);
  await env.chain.write(who, env.chain.usdg, usdgAbi as Abi, "approve", [env.chain.resolver, 2n ** 255n]);
  await env.chain.write(who, env.chain.resolver, ifsoOutcomeResolverAbi as Abi, "propose", [id, outcome, `0x${"ab".repeat(32)}`]);
}
export const questionOnchain = (env: ResolverEnv, id: Hex) =>
  env.chain.pc.readContract({ address: env.chain.resolver, abi: ifsoOutcomeResolverAbi, functionName: "getQuestion", args: [id] });
