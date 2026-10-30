// R1: end to end on a private anvil (port 8745) with the real contracts, a real Postgres and the real indexer:
//  - TIME: the keeper settles after the deadline and the recipient is paid
//  - PRICE AT_DEADLINE across a phase change: the keeper proves the last round before the deadline, the contract
//    takes the first round of the NEXT phase as the hold-window print, and the payment is released
//  - the same on a phase-0 feed (ids like the live SPY / TSLA / AAPL proxies)
//  - claim link: the relayer binds the claimer, the keeper settles, the claimer is paid
//  - expiry: the keeper refunds an undecided escrow to the sender
// Skips when anvil, forge artifacts or Postgres are missing.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { decodeFunctionData, decodeAbiParameters, type Address } from "viem";
import { ifsoEscrowAbi } from "../src/abi";
import { RateLimiter } from "../src/api/rateLimit";
import { relayClaim } from "../src/api/claim";
import { linkKeyAddress, signClaim } from "../src/core/link";
import { Status } from "../src/core/types";
import { escrows, relayTxs } from "../src/db/schema";
import { indexerTick, resetIndexerState } from "../src/workers/indexer";
import { keeperTick } from "../src/workers/keeper";
import { bootChain, bootDb, haveAnvil, havePostgres, makeTestDeps, priceCondition, approveCondition, timeCondition, type TestChain, type TestDb } from "./helpers/chain";
import type { Deps } from "../src/workers/deps";
import { eq } from "drizzle-orm";

setDefaultTimeout(120_000);

describe.skipIf(!haveAnvil() || !havePostgres())("keeper end to end on anvil", () => {
  let chain: TestChain;
  let pg: TestDb;
  let deps: Deps;
  const logs: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
  const sync = () => indexerTick(deps, async () => {});
  const statusOf = async (id: bigint) => Number(((await chain.pc.readContract({ address: chain.escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [id] })) as { status: number }).status);

  beforeAll(async () => {
    resetIndexerState();
    chain = await bootChain();
    pg = await bootDb();
    deps = makeTestDeps(chain, pg.db, {}, (msg, extra) => void logs.push({ msg, extra }));
  });

  afterAll(async () => {
    chain?.stop();
    await pg?.stop();
  });

  test("TIME: nothing before the deadline, settled right after it", async () => {
    const t = await chain.now();
    const deadline = t + 3600n;
    const id = await chain.create(chain.sender, { condition: timeCondition(deadline), expiry: deadline + 2n * 86400n });
    await sync();
    await keeperTick(deps);
    expect(await statusOf(id)).toBe(Status.OPEN);
    const before = await chain.balance(chain.alice.address);
    await chain.warpTo(deadline + 10n);
    await sync();
    await keeperTick(deps);
    expect(await statusOf(id)).toBe(Status.RELEASED);
    expect((await chain.balance(chain.alice.address)) - before).toBe(20_000_000n);
    await sync();
    const [row] = await pg.db.select().from(escrows).where(eq(escrows.id, id.toString()));
    expect(row?.status).toBe(Status.RELEASED);
  }, 60_000);

  test("PRICE AT_DEADLINE across a phase change: proof is the last round of the old phase, next-phase print decides", async () => {
    const feed = await chain.newFeed();
    const t = await chain.now();
    const deadline = t + 3600n;
    const r1 = await chain.push(feed, 90_00000000n, deadline - 7200n);
    const rLast = await chain.push(feed, 95_00000000n, deadline - 2000n); // 2000 s old at the deadline, maxStale 600: stale
    await chain.newPhase(feed);
    const rNext = await chain.push(feed, 120_00000000n, deadline + 1500n); // first print of phase 2, inside the 1 day hold window
    expect(r1 >> 64n).toBe(1n);
    expect(rNext >> 64n).toBe(2n);
    const id = await chain.create(chain.sender, {
      condition: priceCondition({ feed, threshold: 100_00000000n, deadline, maxStale: 600, holdWindow: 86400 }),
      expiry: deadline + 3n * 86400n,
    });
    await sync();
    await chain.warpTo(deadline + 2000n);
    const before = await chain.balance(chain.alice.address);
    await sync();
    await keeperTick(deps);
    expect(await statusOf(id)).toBe(Status.RELEASED); // 120 >= 100: TRUE, paid to alice
    expect((await chain.balance(chain.alice.address)) - before).toBe(20_000_000n);
    // the transaction carried the last round before the deadline as its proof
    const [tx] = await pg.db.select().from(relayTxs).where(eq(relayTxs.escrowId, id.toString()));
    const input = (await chain.pc.getTransaction({ hash: tx!.txHash as `0x${string}` })).input;
    const call = decodeFunctionData({ abi: ifsoEscrowAbi, data: input });
    expect(call.functionName).toBe("settle");
    const [proofRound] = decodeAbiParameters([{ type: "uint80" }], (call.args as readonly unknown[])[1] as `0x${string}`);
    expect(proofRound).toBe(rLast);
  }, 60_000);

  test("PRICE AT_DEADLINE on a phase-0 feed (ids start at 191): FALSE returns the money to the sender", async () => {
    const feed = await chain.newFeed({ phase0: true, startAgg: 190n });
    const t = await chain.now();
    const deadline = t + 3600n;
    const rLast = await chain.push(feed, 80_00000000n, deadline - 100n);
    expect(rLast).toBe(191n);
    await chain.push(feed, 150_00000000n, deadline + 100n); // after the deadline: must not decide it
    const id = await chain.create(chain.sender, {
      condition: priceCondition({ feed, threshold: 100_00000000n, deadline, maxStale: 600, holdWindow: 86400 }),
      expiry: deadline + 3n * 86400n,
    });
    await sync();
    await chain.warpTo(deadline + 500n);
    const before = await chain.balance(chain.sender.address);
    await sync();
    await keeperTick(deps);
    expect(await statusOf(id)).toBe(Status.RETURNED); // 80 < 100: not met
    expect((await chain.balance(chain.sender.address)) - before).toBe(20_000_000n);
  }, 60_000);

  test("claim link: relayer binds the claimer, keeper settles, claimer is paid", async () => {
    const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const t = await chain.now();
    const deadline = t + 3600n;
    const id = await chain.create(chain.sender, { linkKey: linkKeyAddress(secret), condition: timeCondition(deadline), expiry: deadline + 2n * 86400n });
    await sync();
    const e = (await chain.pc.readContract({ address: chain.escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [id] })) as { conditionHash: `0x${string}` };
    const signature = await signClaim({ secret, chainId: 31337, escrow: chain.escrow, id, recipient: chain.bob.address, conditionHash: e.conditionHash });
    const r = await relayClaim(deps, new RateLimiter(), { id, recipient: chain.bob.address as Address, signature, ip: "10.0.0.1" });
    expect(r.status).toBe("bound");
    await chain.warpTo(deadline + 10n);
    const before = await chain.balance(chain.bob.address);
    await sync();
    await keeperTick(deps);
    expect(await statusOf(id)).toBe(Status.RELEASED);
    expect((await chain.balance(chain.bob.address)) - before).toBe(20_000_000n);
  }, 60_000);

  test("expiry: an undecided escrow is refunded to the sender by the keeper", async () => {
    const t = await chain.now();
    const id = await chain.create(chain.sender, { condition: approveCondition(chain.bob.address), expiry: t + 7200n });
    await sync();
    await keeperTick(deps);
    expect(await statusOf(id)).toBe(Status.OPEN);
    await chain.warpTo(t + 7300n);
    const before = await chain.balance(chain.sender.address);
    await sync();
    await keeperTick(deps);
    expect(await statusOf(id)).toBe(Status.RETURNED);
    expect((await chain.balance(chain.sender.address)) - before).toBe(20_000_000n);
  }, 60_000);
});
