// R5: an expired escrow whose primary refund address cannot receive USDG (frozen / blocked by the issuer) is
// refunded to the sender's preset alternate address; with no alternate the keeper raises an ops alert instead of
// looping. Real contracts on anvil port 8745. Skips when anvil or Postgres are missing.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Abi } from "viem";
import { ifsoEscrowAbi } from "../src/abi";
import { Status } from "../src/core/types";
import { relayTxs } from "../src/db/schema";
import { indexerTick, resetIndexerState } from "../src/workers/indexer";
import { keeperTick, resetKeeperBackoff } from "../src/workers/keeper";
import { approveCondition, bootChain, bootDb, haveAnvil, havePostgres, makeTestDeps, type TestChain, type TestDb } from "./helpers/chain";
import type { Deps } from "../src/workers/deps";

setDefaultTimeout(120_000);

describe.skipIf(!haveAnvil() || !havePostgres())("keeper refund fallback", () => {
  let chain: TestChain;
  let pg: TestDb;
  let deps: Deps;
  const alerts: Array<[string, string]> = [];
  const statusOf = async (id: bigint) => Number(((await chain.pc.readContract({ address: chain.escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [id] })) as { status: number }).status);
  const block = (who: `0x${string}`, b: boolean) => chain.write(chain.deployer, chain.usdg, [{ type: "function", name: "setBlocked", stateMutability: "nonpayable", inputs: [{ name: "who", type: "address" }, { name: "b", type: "bool" }], outputs: [] }] as Abi, "setBlocked", [who, b]);

  beforeAll(async () => {
    resetIndexerState();
    resetKeeperBackoff();
    chain = await bootChain();
    pg = await bootDb();
    deps = { ...makeTestDeps(chain, pg.db), alert: async (cause, text) => (alerts.push([cause, text]), true) };
  });
  afterAll(async () => {
    chain?.stop();
    await pg?.stop();
  });

  test("primary blocked: the refund goes to the alternate address", async () => {
    const t = await chain.now();
    const id = await chain.create(chain.sender, { condition: approveCondition(chain.deployer.address), refundTo: chain.alice.address, altRefundTo: chain.bob.address, expiry: t + 7200n });
    await block(chain.alice.address, true);
    await indexerTick(deps, async () => {});
    await chain.warpTo(t + 7300n);
    const before = await chain.balance(chain.bob.address);
    await keeperTick(deps);
    expect(await statusOf(id)).toBe(Status.RETURNED);
    expect((await chain.balance(chain.bob.address)) - before).toBe(20_000_000n);
    const rows = await pg.db.select().from(relayTxs).where(eq(relayTxs.escrowId, id.toString()));
    expect(rows.map((r) => `${r.kind}:${r.status}`).sort()).toEqual(["refund-alt:sent", "refund:skipped"]);
    expect(alerts.length).toBe(0);
  });

  test("primary blocked and no alternate: an alert is raised and the keeper does not send a failing transaction", async () => {
    const t = await chain.now();
    const id = await chain.create(chain.sender, { condition: approveCondition(chain.deployer.address), refundTo: chain.alice.address, expiry: t + 7200n });
    await indexerTick(deps, async () => {});
    await chain.warpTo(t + 7300n);
    await keeperTick(deps);
    expect(await statusOf(id)).toBe(Status.OPEN);
    expect(alerts.some(([cause]) => cause === `refund-stuck-${id}`)).toBe(true);
    const rows = await pg.db.select().from(relayTxs).where(eq(relayTxs.escrowId, id.toString()));
    expect(rows.every((r) => r.status === "skipped")).toBe(true); // simulated first: nothing was broadcast
    // once the issuer unblocks the address the next sweep refunds it to the primary
    await block(chain.alice.address, false);
    const before = await chain.balance(chain.alice.address);
    await keeperTick(deps);
    expect(await statusOf(id)).toBe(Status.OPEN); // R1-M8: the failing row is in backoff, not retried on every sweep
    resetKeeperBackoff(); //                         (stands in for the backoff window passing)
    await keeperTick(deps);
    expect(await statusOf(id)).toBe(Status.RETURNED);
    expect((await chain.balance(chain.alice.address)) - before).toBe(20_000_000n);
  });
});
