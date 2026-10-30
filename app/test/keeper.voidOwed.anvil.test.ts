// todo 11b: an accepted challenge that is voided (expiry with both sides in) pays each side on its own. A side whose
// destination cannot receive is reported with destination 0 and left owed; the keeper pays it with claimVoid (primary,
// then alternate), the indexer records the owed side and the paid side, and the notifier says it plainly.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Abi } from "viem";
import { ifsoEscrowAbi, usdgAbi } from "../src/abi";
import { Status } from "../src/core/types";
import { chainEvents, escrows, relayTxs } from "../src/db/schema";
import { indexerTick, resetIndexerState, VOID_OWED_COUNTER, VOID_OWED_SENDER } from "../src/workers/indexer";
import { keeperTick, resetKeeperBackoff } from "../src/workers/keeper";
import { render } from "../src/workers/notifier";
import { approveCondition, bootChain, bootDb, haveAnvil, havePostgres, makeTestDeps, type TestChain, type TestDb } from "./helpers/chain";
import type { Deps } from "../src/workers/deps";

setDefaultTimeout(180_000);

describe.skipIf(!haveAnvil() || !havePostgres())("keeper pays owed sides of a voided challenge", () => {
  let chain: TestChain;
  let pg: TestDb;
  let deps: Deps;
  const alerts: Array<[string, string]> = [];
  const notes: Array<{ name: string; args: Record<string, unknown> }> = [];
  const block = (who: `0x${string}`, b: boolean) => chain.write(chain.deployer, chain.usdg, [{ type: "function", name: "setBlocked", stateMutability: "nonpayable", inputs: [{ name: "who", type: "address" }, { name: "b", type: "bool" }], outputs: [] }] as Abi, "setBlocked", [who, b]);
  const row = async (id: bigint) => (await pg.db.select().from(escrows).where(eq(escrows.id, id.toString())))[0]!;
  const tick = () => indexerTick(deps, async (ev) => void notes.push({ name: ev.name, args: ev.args }));

  /** sender -> alice challenge with both sides in, expiring in 2 h. */
  async function acceptedChallenge(refund: { refundTo?: `0x${string}`; altRefundTo?: `0x${string}` }) {
    const t = await chain.now();
    const id = await chain.create(chain.sender, {
      condition: approveCondition(chain.deployer.address),
      recipient: chain.alice.address,
      twoSided: true,
      counterAmount: 15_000_000n,
      acceptBy: t + 1800n,
      expiry: t + 7200n,
      ...refund,
    });
    await chain.mint(chain.alice.address, 20);
    await chain.write(chain.alice, chain.usdg, usdgAbi as Abi, "approve", [chain.escrow, 2n ** 255n]);
    await chain.write(chain.alice, chain.escrow, ifsoEscrowAbi as Abi, "accept", [id, "0x", chain.alice.address]);
    return { id, t };
  }

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

  test("acceptor side owed: the sender is paid at once, the acceptor's stake waits, then the keeper pays it and the indexer clears it", async () => {
    const { id, t } = await acceptedChallenge({});
    await tick();
    await block(chain.alice.address, true);
    await chain.warpTo(t + 7300n);
    const senderBefore = await chain.balance(chain.sender.address);
    await keeperTick(deps); // refund -> VOID with the acceptor side unpayable
    await tick();
    const r = await row(id);
    expect(r.status).toBe(Status.VOIDED);
    expect(r.voidOwed).toBe(VOID_OWED_COUNTER);
    expect((await chain.balance(chain.sender.address)) - senderBefore).toBe(20_000_000n);
    const voided = notes.find((n) => n.name === "Voided")!;
    expect(String(voided.args.counterTo)).toBe("0x0000000000000000000000000000000000000000");

    // wording: the acceptor (recipient role) is told its side is held; the sender is told everyone was paid
    expect(render("Voided", { role: "recipient", amount: "20000000" }, voided.args)).toContain("being held for you");
    expect(render("Voided", { role: "sender", amount: "20000000" }, voided.args)).not.toContain("being held");

    // still frozen: the keeper tries both addresses, fails without sending, backs off
    await keeperTick(deps);
    expect((await row(id)).voidOwed).toBe(VOID_OWED_COUNTER);
    const skipped = (await pg.db.select().from(relayTxs).where(eq(relayTxs.escrowId, id.toString()))).filter((x) => x.kind.startsWith("claim-void"));
    expect(skipped.every((x) => x.status === "skipped")).toBe(true);

    // unfrozen: paid; VoidClaimed indexed; owed cleared
    await block(chain.alice.address, false);
    resetKeeperBackoff();
    const aliceBefore = await chain.balance(chain.alice.address);
    await keeperTick(deps);
    expect((await chain.balance(chain.alice.address)) - aliceBefore).toBe(15_000_000n);
    await tick();
    expect((await row(id)).voidOwed).toBe(0);
    const events = await pg.db.select().from(chainEvents).where(eq(chainEvents.escrowId, id.toString()));
    expect(events.map((e) => e.name)).toContain("VoidClaimed");
    expect(notes.some((n) => n.name === "VoidClaimed")).toBe(true);
    expect(render("VoidClaimed", { role: "recipient" }, notes.find((n) => n.name === "VoidClaimed")!.args)).toContain("held after a voided challenge");
    expect(alerts.map(([c]) => c)).toEqual([`void-stuck-${id}-counter`]); // raised once, while it was frozen
  });

  test("sender side owed with an alternate address: primary refused, the keeper retries with alt and the alternate is paid", async () => {
    const { id, t } = await acceptedChallenge({ refundTo: chain.deployer.address, altRefundTo: chain.bob.address });
    await tick();
    await block(chain.deployer.address, true);
    await chain.warpTo(t + 7300n);
    await keeperTick(deps);
    await tick();
    expect((await row(id)).voidOwed).toBe(VOID_OWED_SENDER);
    resetKeeperBackoff();
    const bobBefore = await chain.balance(chain.bob.address);
    await keeperTick(deps);
    expect((await chain.balance(chain.bob.address)) - bobBefore).toBe(20_000_000n);
    await tick();
    expect((await row(id)).voidOwed).toBe(0);
    const kinds = (await pg.db.select().from(relayTxs).where(eq(relayTxs.escrowId, id.toString()))).map((x) => `${x.kind}:${x.status}`);
    expect(kinds).toContain("claim-void:skipped");
    expect(kinds).toContain("claim-void-alt:sent");
    await block(chain.deployer.address, false);
  });
});
