// Real-user counter on a private anvil (port 8745) with the real contracts, a real Postgres and the real indexer:
// the counter from indexed events (GET /stats/users and the tRPC query), the chain-log script (no DB) and a
// brute-force count straight from getLogs must all agree, with our own wallet left out.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Abi, Address } from "viem";
import { ifsoEscrowAbi, usdgAbi } from "../src/abi";
import { createApp } from "../src/api/app";
import { appRouter } from "../src/api/router";
import { RateLimiter } from "../src/api/rateLimit";
import { getLogsChunked } from "../src/chain/rpc";
import { decodeEventLog } from "viem";
import { indexerTick, resetIndexerState } from "../src/workers/indexer";
import { approveCondition, bootChain, bootDb, haveAnvil, havePostgres, makeTestDeps, timeCondition, type TestChain, type TestDb } from "./helpers/chain";
import { countUsers, main as userCountMain } from "../scripts/user-count";
import type { Deps } from "../src/workers/deps";

setDefaultTimeout(180_000);

describe.skipIf(!haveAnvil() || !havePostgres())("real-user counter on anvil", () => {
  let chain: TestChain;
  let pg: TestDb;
  let deps: Deps;
  let internal: string[];
  const person = () => privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    resetIndexerState();
    chain = await bootChain();
    pg = await bootDb();
    const bob = chain.bob;
    const dave = person();
    const carol = person();
    await chain.fund(dave.address);
    const t = await chain.now();
    const dl = t + 3600n;
    // chain.sender is OUR wallet: two escrows to alice
    await chain.create(chain.sender, { condition: timeCondition(dl), recipient: chain.alice.address });
    await chain.create(chain.sender, { condition: timeCondition(dl), recipient: chain.alice.address });
    // bob: two escrows (alice, carol)
    await chain.create(bob, { condition: timeCondition(dl), recipient: chain.alice.address });
    await chain.create(bob, { condition: timeCondition(dl), recipient: carol.address });
    // alice pays bob
    await chain.create(chain.alice, { condition: timeCondition(dl), recipient: bob.address });
    // dave opens a challenge to alice (counter 15), alice accepts
    const id = await chain.create(dave, { condition: approveCondition(chain.deployer.address), recipient: chain.alice.address, twoSided: true, counterAmount: 15_000_000n, acceptBy: t + 1800n, expiry: t + 7200n });
    await chain.mint(chain.alice.address, 20);
    await chain.write(chain.alice, chain.usdg, usdgAbi as Abi, "approve", [chain.escrow, 2n ** 255n]);
    await chain.write(chain.alice, chain.escrow, ifsoEscrowAbi as Abi, "accept", [id, "0x", chain.alice.address]);
    internal = [chain.sender.address];
    deps = makeTestDeps(chain, pg.db, { INTERNAL_ADDRESSES: internal.join(",") });
    await indexerTick(deps, async () => {});
  });

  afterAll(async () => {
    chain?.stop();
    await pg?.stop();
  });

  /** Independent brute force: raw logs, plain sets, no shared code with core/stats. */
  async function brute() {
    const logs = await getLogsChunked(chain.pc, { address: chain.escrow, fromBlock: 0n, toBlock: await chain.pc.getBlockNumber() });
    const senders = new Set<string>(), recipients = new Set<string>(), acceptors = new Set<string>();
    let created = 0, volume = 0n;
    const skip = new Set(internal.map((a) => a.toLowerCase()));
    const own = new Set<string>();
    const counters = new Map<string, bigint>();
    const evs = logs.map((l) => {
      try { return decodeEventLog({ abi: ifsoEscrowAbi, data: l.data, topics: l.topics }) as { eventName: string; args: any }; } catch { return undefined; }
    }).filter(Boolean) as { eventName: string; args: any }[];
    for (const e of evs) if (e.eventName === "Created") {
      const s = String(e.args.sender).toLowerCase();
      if (skip.has(s)) { own.add(String(e.args.id)); continue; }
      senders.add(s); created++; volume += e.args.amount; counters.set(String(e.args.id), e.args.counterAmount);
      if (/[1-9a-f]/i.test(String(e.args.recipient).slice(2))) recipients.add(String(e.args.recipient).toLowerCase());
    }
    for (const e of evs) if (e.eventName === "Accepted") {
      const a = String(e.args.acceptor).toLowerCase();
      if (skip.has(a)) continue;
      acceptors.add(a); recipients.add(a);
      if (!own.has(String(e.args.id))) volume += counters.get(String(e.args.id)) ?? 0n;
    }
    return { uniqueSenders: senders.size, uniqueRecipients: recipients.size, uniqueAcceptors: acceptors.size, escrowsCreated: created, volumeUsdg: volume.toString() };
  }

  const expected = { uniqueSenders: 3, uniqueRecipients: 3, uniqueAcceptors: 1, escrowsCreated: 4, volumeUsdg: String(95_000_000) };

  test("the brute-force count is what the scenario says (our own wallet left out)", async () => {
    expect(await brute()).toEqual(expected);
  });

  test("GET /stats/users (indexed events) equals the brute-force count, with per-day rows", async () => {
    const app = createApp(deps, new RateLimiter());
    const r = await app.request("/stats/users");
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect({ uniqueSenders: j.uniqueSenders, uniqueRecipients: j.uniqueRecipients, uniqueAcceptors: j.uniqueAcceptors, escrowsCreated: j.escrowsCreated, volumeUsdg: j.volumeUsdg }).toEqual(await brute());
    expect(j.perDay.length).toBeGreaterThanOrEqual(1);
    expect(j.perDay.reduce((n: number, d: any) => n + d.escrowsCreated, 0)).toBe(4);
    expect((await app.request("/stats/users?since=garbage")).status).toBe(400);
  });

  test("the tRPC stats query is the same thing; our wallet changes the numbers when not listed", async () => {
    const caller = appRouter.createCaller({ deps, limiter: new RateLimiter(), ip: "203.0.113.1" });
    const s = await caller.stats();
    expect(s).toMatchObject(expected);
    const none = makeTestDeps(chain, pg.db, {});
    const all = await appRouter.createCaller({ deps: none, limiter: new RateLimiter(), ip: "203.0.113.1" }).stats();
    expect(all.escrowsCreated).toBe(6);
    expect(all.uniqueSenders).toBe(4);
  });

  test("scripts/user-count.ts reads the same numbers from chain logs, no database", async () => {
    const stats = await countUsers({ pc: chain.pc, escrow: chain.escrow, sinceSec: 0, internal });
    expect(stats).toMatchObject(expected);
    const lines: string[] = [];
    const code = await userCountMain(["--since", "2000-01-01", "--escrow", chain.escrow, "--internal", internal.join(","), "--json"], (s) => lines.push(s), chain.pc);
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject(expected);
    const text: string[] = [];
    await userCountMain(["--since=2000-01-01", `--escrow=${chain.escrow}`, `--internal=${internal.join(",")}`], (s) => text.push(s), chain.pc);
    expect(text.join("\n")).toContain("senders     3");
  });

  test("--since in the future finds nothing", async () => {
    const stats = await countUsers({ pc: chain.pc, escrow: chain.escrow, sinceSec: Math.floor(Date.now() / 1000) + 10 * 86400, internal });
    expect(stats.escrowsCreated).toBe(0);
    expect(stats.perDay).toEqual([]);
  });
});
