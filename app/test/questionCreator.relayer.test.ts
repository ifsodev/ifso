// Testnet run 2026-11-02 (bug 4): the API registered OUTCOME questions with the RESOLVER hot key, which the api role
// never holds (env.ts asks it for the relayer only; provision.sh and ifso-api.service keep the resolver key out of its
// view). Every OUTCOME submit failed with "createQuestion failed: hot key not configured". Decision: the RELAYER key is
// the resolver's question creator (createQuestion costs gas only, no bond); the resolver key with the bond float stays
// worker-only and keeps proposing / disputing / finalizing.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Abi, Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ifsoOutcomeResolverAbi } from "../src/abi";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter, paramsFromJson } from "../src/api/router";
import { loadEnv, missingFor } from "../src/config/env";
import { createAuthNonce } from "../src/core/condition";
import { createAuthorizationTypedData } from "../src/core/typedData";
import { questions, relayTxs } from "../src/db/schema";
import type { Deps } from "../src/workers/deps";
import { ensureFootballQuestion, resolverTick } from "../src/workers/resolver";
import { bootDb, haveAnvil, havePostgres, makeTestDeps, type TestDb } from "./helpers/chain";
import { bootResolverEnv, onchainState, questionOnchain, type ResolverEnv } from "./helpers/resolverHarness";
import { eplEvents, expectedFootball, oddsScores } from "./helpers/resolverFixtures";

setDefaultTimeout(120_000);

const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const RESOLVER = "0x00000000000000000000000000000000000e5c21" as Address;
const RELAYER = "0x00000000000000000000000000000000000000ee" as Address;
const SENDER_ACC = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex); // test-key
const SENDER = SENDER_ACC.address;

describe("the api role registers questions without the resolver key", () => {
  test("env: the api needs only the relayer key; the resolver key stays a worker variable", () => {
    const base = { DATABASE_URL: "x", ESCROW_ADDRESS: ESCROW, REDIS_URL: "x", RESOLVER_ADDRESS: RESOLVER };
    expect(missingFor("api", { ...base, RELAYER_KEYSTORE: "k", RELAYER_PASSWORD_FILE: "p" })).toEqual([]);
    expect(missingFor("worker", { ...base, KEEPER_PK: "0x01" })).toContain("RESOLVER_KEYSTORE");
  });
});

describe.skipIf(!havePostgres())("submit of an OUTCOME payment with the api role's keys only (stubbed chain)", () => {
  let pg: TestDb;
  let sent: Array<{ functionName: string; by: string }>;
  let deps: Deps;
  beforeAll(async () => {
    pg = await bootDb();
  });
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    sent = [];
    await pg.db.delete(questions);
    await pg.db.delete(relayTxs);
    const relayer = { account: { address: RELAYER }, writeContract: async (req: { functionName: string }) => (sent.push({ functionName: req.functionName, by: RELAYER }), "0xabc" as Hex) };
    const market = { slug: "good", question: "q good", conditionId: "0x" + "11".repeat(32), closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', endDate: new Date(Date.now() + 10 * 86400_000).toISOString(), liquidityNum: 40_000, volumeNum: 200_000 };
    deps = {
      env: loadEnv({ ESCROW_ADDRESS: ESCROW, RESOLVER_ADDRESS: RESOLVER }),
      log: () => {},
      db: pg.db,
      sources: { gamma: async () => ({ report: { provider: "polymarket-gamma", fetchedAt: 0, digest: "0x", status: "pending" }, market }) } as never,
      clients: {
        chain: { id: 4663 },
        escrow: ESCROW,
        usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        resolverContract: RESOLVER,
        relayer,
        resolver: undefined, // exactly the api role on the server: no resolver key in its view
        publicClient: {
          readContract: async ({ functionName }: { functionName: string }) => (functionName === "feeFor" ? 750_000n : functionName === "balanceOf" ? 50_000_000n : functionName === "getQuestion" ? { state: 0 } : 0n),
          simulateContract: async (req: unknown) => ({ request: req }),
          estimateContractGas: async () => 100_000n,
          getGasPrice: async () => 1_000_000n,
          waitForTransactionReceipt: async () => ({ status: "success" }),
        },
      },
    } as unknown as Deps;
  });

  test("build + sign + submit registers the question with the relayer and relays the create", async () => {
    const c = appRouter.createCaller({ deps, limiter: new RateLimiter(), ip: "203.0.113.7", country: "DE" });
    const built = (await c.build({ text: "/ifso @sam 10 if https://polymarket.com/event/good resolves yes", sender: SENDER, linkKey: "0x000000000000000000000000000000000000c0de" })) as { params: Record<string, unknown> };
    const p = paramsFromJson(built.params);
    const signature = await SENDER_ACC.signTypedData(createAuthorizationTypedData({ chainId: 4663, usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", escrow: ESCROW, from: SENDER, value: p.amount + 750_000n, validAfter: 0n, validBefore: 9999999999n, nonce: createAuthNonce(SENDER, p) }));
    await c.submit({ params: built.params, from: SENDER, validAfter: "0", validBefore: "9999999999", signature } as never);
    expect(sent).toEqual([
      { functionName: "createQuestion", by: RELAYER },
      { functionName: "createWithAuthorization", by: RELAYER },
    ]);
    expect((await pg.db.select().from(questions))[0]!.state).toBe(1);
  });
});

describe.skipIf(!haveAnvil() || !havePostgres())("on anvil: relayer creates the question, the resolver key proposes and finalizes", () => {
  let env: ResolverEnv;
  beforeAll(async () => {
    env = await bootResolverEnv();
  });
  afterAll(async () => env?.stop());

  test("api deps without RESOLVER_PK register; the worker's resolver key resolves", async () => {
    const relayer = privateKeyToAccount(env.chain.relayerKey).address;
    const isCreator = (a: Address) => env.chain.pc.readContract({ address: env.chain.resolver, abi: ifsoOutcomeResolverAbi as Abi, functionName: "isCreator", args: [a] });
    expect(await isCreator(relayer)).toBe(true);
    expect(await isCreator(env.resolverAddress)).toBe(false); // the bond key is not a creator any more

    const apiDeps = makeTestDeps(env.chain, env.pg.db, { RESOLVER_PK: "", ODDS_API_KEY: "test-key" });
    expect(apiDeps.clients.resolver).toBeUndefined();
    const e = eplEvents[7]!;
    const odds = oddsScores.find((s) => s._derivedFrom === e.idEvent)!;
    const fixture = { sportKey: "soccer_epl", oddsApiEventId: odds.id, sportsDbEventId: e.idEvent, home: e.strHomeTeam, away: e.strAwayTeam, commenceTime: Number(await env.chain.now()) + 3600 };
    const q = await ensureFootballQuestion({ ...apiDeps, sources: env.deps.sources }, fixture);
    expect(Number((await questionOnchain(env, q.id)).state)).toBe(1);
    const [tx] = await env.pg.db.select().from(relayTxs).where(eq(relayTxs.questionId, q.id));
    expect(tx!.kind).toBe("question-create");
    const created = await env.chain.pc.getTransaction({ hash: tx!.txHash as Hex });
    expect(created.from.toLowerCase()).toBe(relayer.toLowerCase());

    // the worker (resolver key) still proposes after earliestResolve and finalizes after the dispute window
    const { createOutcomeEscrow } = await import("./helpers/resolverHarness");
    const { indexerTick } = await import("../src/workers/indexer");
    await createOutcomeEscrow(env, q.id, BigInt(q.earliestResolve + 30 * 86400));
    await indexerTick(env.deps, async () => {});
    await env.chain.warpTo(BigInt(q.earliestResolve + 1));
    await resolverTick(env.deps);
    const c = await questionOnchain(env, q.id);
    expect(Number(c.state)).toBe(2);
    expect(c.proposer.toLowerCase()).toBe(env.resolverAddress.toLowerCase());
    await env.chain.warpTo(BigInt(Number(c.proposedAt) + 7201));
    await resolverTick(env.deps);
    expect(await onchainState(env, q.id)).toEqual([4, expectedFootball(e)]);
  });
});
