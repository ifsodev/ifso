// R4: the indexer survives a reorg. Fork A (created escrows, a referee release) is mined, indexed, then replaced
// on anvil by fork B (snapshot / revert + different transactions). The indexer notices that the cursor block's hash
// changed, rewinds 50 blocks, drops what fork A produced, repairs the touched rows from the chain and replays:
// fork-A-only escrows vanish, a release that never happened is undone, an escrow that exists on both forks appears
// once, and no event is stored twice. A restart resumes from the stored cursor. Anvil port 8745 + Postgres 5442.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { keccak256, toHex, type Abi, type Hex } from "viem";
import { ifsoEscrowAbi } from "../src/abi";
import { makeAlert } from "../src/ops/alerts";
import { Status } from "../src/core/types";
import { chainEvents, cursors, escrows } from "../src/db/schema";
import { REWIND_BLOCKS, indexerTick, resetIndexerState, type NotifyEvent } from "../src/workers/indexer";
import { approveCondition, bootChain, bootDb, haveAnvil, havePostgres, makeTestDeps, type TestChain, type TestDb } from "./helpers/chain";
import type { Deps } from "../src/workers/deps";

setDefaultTimeout(120_000);

describe.skipIf(!haveAnvil() || !havePostgres())("indexer reorg safety", () => {
  let chain: TestChain;
  let pg: TestDb;
  let deps: Deps;
  const seen: NotifyEvent[] = [];
  const alerts: string[] = []; // causes raised and logged by the real alert function
  const sent: string[] = []; //   Telegram sends (armed, fake fetch): a reorg rewind heals itself, so none
  const alertFn = () =>
    makeAlert({
      armed: true, token: "T", chatId: "1",
      log: (_m, x) => void (x?.cause && alerts.push(String(x.cause))),
      fetchImpl: (async (_u: string, init: { body: string }) => (sent.push(init.body), { ok: true, status: 200 })) as never,
    });
  const sync = () => indexerTick(deps, async (e) => void seen.push(e));
  const salt = (s: string) => keccak256(toHex(s));
  const idOf = async (from: Hex, s: Hex) => (await chain.pc.readContract({ address: chain.escrow, abi: ifsoEscrowAbi, functionName: "idFor", args: [from, s] })) as bigint;
  const row = async (id: bigint) => (await pg.db.select().from(escrows).where(eq(escrows.id, id.toString())))[0];

  beforeAll(async () => {
    resetIndexerState();
    chain = await bootChain();
    pg = await bootDb();
    deps = { ...makeTestDeps(chain, pg.db), alert: alertFn() };
  });
  afterAll(async () => {
    chain?.stop();
    await pg?.stop();
  });

  test("a restart resumes from the cursor without re-reading or re-announcing anything", async () => {
    const e0 = await chain.create(chain.sender, { condition: approveCondition(chain.deployer.address), salt: salt("e0") });
    await chain.mine(60); // far enough from block 0 that a 50-block rewind lands inside the indexed range
    await sync();
    expect((await row(e0))?.status).toBe(Status.OPEN);
    const n = seen.length;
    expect(n).toBeGreaterThan(0);
    resetIndexerState(); // new process
    deps = { ...makeTestDeps(chain, pg.db), alert: alertFn() };
    await sync();
    expect(seen.length).toBe(n);
    const [cur] = await pg.db.select().from(cursors).where(eq(cursors.name, "main"));
    expect(cur!.hash).toBe((await chain.pc.getBlock({ blockNumber: cur!.block })).hash);
  });

  test("replacing the last blocks: fork-A-only rows vanish, undone releases revert, shared escrows appear once, no duplicate events", async () => {
    const e0 = await idOf(chain.sender.address, salt("e0"));
    const snap = await chain.snapshot();

    // fork A: two new escrows (A1 only here, S on both forks) and a referee release of e0
    const a1 = await chain.create(chain.sender, { condition: approveCondition(chain.deployer.address), salt: salt("a1") });
    const shared = await chain.create(chain.sender, { condition: approveCondition(chain.deployer.address), salt: salt("shared") });
    await chain.write(chain.deployer, chain.escrow, ifsoEscrowAbi as Abi, "refereeDecide", [e0, true]);
    await chain.mine(2);
    await sync();
    expect((await row(a1))?.id).toBe(a1.toString());
    expect((await row(e0))?.status).toBe(Status.RELEASED);
    const [curA] = await pg.db.select().from(cursors).where(eq(cursors.name, "main"));
    const hashA = curA!.hash;

    // fork B replaces those blocks: only `shared` and a new b1 are created; e0 is NOT released
    await chain.revert(snap);
    expect(await chain.snapshot()).toBeTruthy();
    const sharedB = await chain.create(chain.sender, { condition: approveCondition(chain.deployer.address), salt: salt("shared") });
    const b1 = await chain.create(chain.sender, { condition: approveCondition(chain.deployer.address), salt: salt("b1") });
    await chain.mine(3);
    expect(sharedB).toBe(shared);
    expect((await chain.pc.getBlock({ blockNumber: curA!.block })).hash).not.toBe(hashA); // the cursor block was replaced

    await sync();
    expect(await row(a1)).toBeUndefined(); //                           existed only on fork A
    expect((await row(b1))?.status).toBe(Status.OPEN); //               only on fork B
    expect((await row(shared))?.status).toBe(Status.OPEN); //           on both, stored once
    expect((await row(e0))?.status).toBe(Status.OPEN); //               the release was undone
    expect(alerts).toContain("indexer-reorg"); // raised and logged
    expect(sent).toEqual([]); //                 but never sent: log-only, self-healing

    const events = await pg.db.select().from(chainEvents);
    const keys = events.map((e) => `${e.blockNumber}:${e.logIndex}`);
    expect(new Set(keys).size).toBe(keys.length);
    const created = events.filter((e) => e.name === "Created").map((e) => e.escrowId);
    expect(new Set(created).size).toBe(created.length); //                one Created per escrow
    expect(events.some((e) => e.escrowId === a1.toString())).toBe(false);
    expect(events.some((e) => e.name === "Released")).toBe(false);

    const [cur] = await pg.db.select().from(cursors).where(eq(cursors.name, "main"));
    expect(cur!.hash).toBe((await chain.pc.getBlock({ blockNumber: cur!.block })).hash);
    expect(cur!.block).toBe(await chain.pc.getBlockNumber({ cacheTime: 0 }));
    expect(REWIND_BLOCKS).toBe(50n);
  });

  test("a second sync after the replay changes nothing", async () => {
    const before = (await pg.db.select().from(chainEvents)).length;
    const n = seen.length;
    await sync();
    expect((await pg.db.select().from(chainEvents)).length).toBe(before);
    expect(seen.length).toBe(n);
  });
});
