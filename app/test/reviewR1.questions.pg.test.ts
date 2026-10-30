// R1-M7: `build` only PLANS a question (no chain write, no bond). The resolver key registers it when a funded
// sender is about to create the escrow. Real Postgres, stubbed chain.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { createApp } from "../src/api/app";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter } from "../src/api/router";
import { loadEnv } from "../src/config/env";
import { questions, relayTxs } from "../src/db/schema";
import type { Deps } from "../src/workers/deps";
import { bootDb, havePostgres, type TestDb } from "./helpers/chain";

setDefaultTimeout(60_000);
const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const RESOLVER = "0x00000000000000000000000000000000000e5c21" as Address;
const SENDER = "0x0000000000000000000000000000000000005e4d" as Address;
const LINK = "0x000000000000000000000000000000000000c0de" as Address;

describe.skipIf(!havePostgres())("R1-M7: questions are planned off-chain and registered for funded senders only", () => {
  let pg: TestDb;
  let sent: Array<{ functionName: string; args: unknown[] }>;
  let balance = 0n;
  let markets: Record<string, Record<string, unknown>>;
  let deps: Deps;
  const endIso = () => new Date(Date.now() + 10 * 86400_000).toISOString();
  const market = (slug: string, o: Record<string, unknown> = {}) => ({ slug, question: `q ${slug}`, conditionId: "0x" + "11".repeat(32), closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', endDate: endIso(), liquidityNum: 40_000, volumeNum: 200_000, ...o });
  const make = (env: Record<string, string> = {}) => {
    const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" }, writeContract: async (req: { functionName: string; args: unknown[] }) => (sent.push(req), "0xabc" as Hex) };
    deps = {
      env: loadEnv({ ESCROW_ADDRESS: ESCROW, RESOLVER_ADDRESS: RESOLVER, ...env }),
      log: () => {},
      db: pg.db,
      sources: { gamma: async (slug: string) => ({ report: { provider: "polymarket-gamma", fetchedAt: 0, digest: "0x", status: "pending" }, market: markets[slug] }) } as never,
      clients: {
        chain: { id: 4663 },
        escrow: ESCROW,
        usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        resolverContract: RESOLVER,
        relayer: wallet,
        resolver: wallet,
        publicClient: {
          readContract: async ({ functionName }: { functionName: string }) => (functionName === "feeFor" ? 750_000n : functionName === "balanceOf" ? balance : functionName === "getQuestion" ? { state: 0 } : 0n),
          simulateContract: async (req: unknown) => ({ request: req }),
          estimateContractGas: async () => 100_000n,
          getGasPrice: async () => 1_000_000n,
          waitForTransactionReceipt: async () => ({ status: "success" }),
        },
      },
    } as unknown as Deps;
    return deps;
  };
  const build = (slug: string, sender: Address = SENDER, ip = "203.0.113.7", limiter = new RateLimiter(), extra = "") =>
    appRouter.createCaller({ deps, limiter, ip, country: "DE" }).build({ text: `/ifso @sam 10 if https://polymarket.com/event/${slug} resolves yes${extra}`, sender, linkKey: LINK });
  const creates = () => sent.filter((s) => s.functionName === "createQuestion").length;

  beforeAll(async () => {
    pg = await bootDb();
  });
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    sent = [];
    balance = 0n;
    markets = {};
    await pg.db.delete(questions);
    await pg.db.delete(relayTxs);
    make();
  });

  test("build plans the question (state 0, public spec served) and sends nothing from the resolver key", async () => {
    markets["good"] = market("good");
    const r = (await build("good")) as { params: { condition: { key: Hex } } };
    expect(creates()).toBe(0);
    const [row] = await pg.db.select().from(questions).where(eq(questions.id, r.params.condition.key));
    expect(row?.state).toBe(0);
    const res = await createApp(deps, new RateLimiter()).request(`/q/${row!.specHash}.json`);
    expect(res.status).toBe(200);
  });

  test("a thin, quiet, closed or odd market is refused at build; nothing is stored", async () => {
    markets["thin"] = market("thin", { liquidityNum: 12 });
    markets["quiet"] = market("quiet", { volumeNum: 5 });
    markets["closed"] = market("closed", { closed: true });
    markets["multi"] = market("multi", { outcomes: '["A","B","C"]' });
    for (const s of ["thin", "quiet", "closed", "multi", "missing"]) await expect(build(s)).rejects.toThrow();
    expect((await pg.db.select().from(questions)).length).toBe(0);
    expect(creates()).toBe(0);
  });

  test("new question planning is limited per sender and per network; an already-planned question is not counted", async () => {
    for (let i = 0; i < 8; i++) markets[`m${i}`] = market(`m${i}`);
    make({ BUILD_QUESTIONS_PER_SENDER_PER_HOUR: "2", BUILD_QUESTIONS_PER_IP_PER_HOUR: "1000" });
    const limiter = new RateLimiter();
    for (let i = 0; i < 8; i++) await build(`m${i}`, SENDER, "203.0.113.7", limiter).catch(() => {});
    expect((await pg.db.select().from(questions)).length).toBe(2);
    await build("m0", SENDER, "203.0.113.7", limiter); // known question: no new row, no budget used
    make({ BUILD_QUESTIONS_PER_SENDER_PER_HOUR: "1000", BUILD_QUESTIONS_PER_IP_PER_HOUR: "3" });
    const l2 = new RateLimiter();
    for (let i = 0; i < 8; i++) await build(`m${i}`, `0x${(10 + i).toString(16).padStart(40, "0")}` as Address, "198.51.100.5", l2).catch(() => {});
    expect((await pg.db.select().from(questions)).length).toBe(2 + 3); // m0 and m1 were already planned (free); this network may plan 3 more
  });

  test("a challenge on a market already priced as decided is refused", async () => {
    markets["done"] = market("done", { outcomePrices: '["0.99","0.01"]' });
    await expect(build("done", SENDER, "203.0.113.7", new RateLimiter(), " vs @jo 10")).rejects.toThrow();
  });

  test("prepareQuestion: an unfunded wallet registers nothing; a funded one registers once", async () => {
    markets["good"] = market("good");
    const r = (await build("good")) as { params: { condition: { key: Hex } } };
    const id = r.params.condition.key;
    const c = appRouter.createCaller({ deps, limiter: new RateLimiter(), ip: "203.0.113.7", country: "DE" });
    balance = 100_000n; // 0.1 USDG: cannot cover the 0.75 fee plus the 1 USDG minimum
    await expect(c.prepareQuestion({ questionId: id, sender: SENDER })).rejects.toThrow("does not hold enough");
    expect(creates()).toBe(0);
    balance = 5_000_000n;
    await c.prepareQuestion({ questionId: id, sender: SENDER });
    await c.prepareQuestion({ questionId: id, sender: SENDER });
    expect(creates()).toBe(1);
    expect((await pg.db.select().from(questions).where(eq(questions.id, id)))[0]!.state).toBe(1);
    await expect(c.prepareQuestion({ questionId: ("0x" + "00".repeat(32)) as Hex, sender: SENDER })).rejects.toThrow("unknown question");
  });

  test("submit for an outcome payment registers the question only when the sender holds the funds", async () => {
    markets["good"] = market("good");
    const built = (await build("good")) as { params: Record<string, unknown> };
    const base = { params: built.params, from: SENDER, validAfter: "0", validBefore: "9999999999", signature: "0x01" };
    const c = appRouter.createCaller({ deps, limiter: new RateLimiter(), ip: "203.0.113.7", country: "DE" });
    balance = 0n;
    await expect(c.submit(base as never)).rejects.toThrow("does not hold enough");
    expect(sent.length).toBe(0);
    balance = 50_000_000n;
    await c.submit(base as never);
    expect(sent.map((s) => s.functionName)).toEqual(["createQuestion", "createWithAuthorization"]);
  });

  test("the stranger PoC: 25 builds for 25 open markets cost the resolver key nothing", async () => {
    for (let i = 0; i < 25; i++) markets[`s${i}`] = market(`s${i}`);
    make({ BUILD_QUESTIONS_PER_SENDER_PER_HOUR: "1000", BUILD_QUESTIONS_PER_IP_PER_HOUR: "1000" });
    for (let i = 0; i < 25; i++) await build(`s${i}`).catch(() => {});
    expect(creates()).toBe(0);
  });

});
