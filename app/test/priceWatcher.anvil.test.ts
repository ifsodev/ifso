// The price watcher on a private anvil (port 8745): a TOUCH crossing is settled with the round that crossed, even when
// the price moved back before the poll; the cursor survives a restart; rounds across a phase change are walked;
// rounds outside the window are ignored; an escrow the indexer learns about late is checked against rounds the
// cursor already passed. Skips when anvil or Postgres are missing.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { decodeAbiParameters, decodeFunctionData } from "viem";
import { ifsoEscrowAbi } from "../src/abi";
import { Status } from "../src/core/types";
import { cursors, relayTxs } from "../src/db/schema";
import { indexerTick, resetIndexerState } from "../src/workers/indexer";
import { priceWatchTick, resetWatcherState } from "../src/workers/priceWatcher";
import { bootChain, bootDb, haveAnvil, havePostgres, makeTestDeps, priceCondition, type TestChain, type TestDb } from "./helpers/chain";
import type { Deps } from "../src/workers/deps";

setDefaultTimeout(120_000);
const px = (n: number) => BigInt(n) * 100_000_000n;

describe.skipIf(!haveAnvil() || !havePostgres())("price watcher", () => {
  let chain: TestChain;
  let pg: TestDb;
  let deps: Deps;
  const sync = () => indexerTick(deps, async () => {});
  const statusOf = async (id: bigint) => Number(((await chain.pc.readContract({ address: chain.escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [id] })) as { status: number }).status);
  const proofOf = async (id: bigint) => {
    const rows = await pg.db.select().from(relayTxs).where(eq(relayTxs.escrowId, id.toString()));
    const mined = rows.find((r) => r.status === "sent")!;
    const input = (await chain.pc.getTransaction({ hash: mined.txHash as `0x${string}` })).input;
    const call = decodeFunctionData({ abi: ifsoEscrowAbi, data: input });
    return decodeAbiParameters([{ type: "uint80" }], (call.args as readonly unknown[])[1] as `0x${string}`)[0];
  };
  const touch = async (feed: `0x${string}`, threshold: number, o: { op?: number; startOffset?: number } = {}) => {
    const t = await chain.now();
    return chain.create(chain.sender, {
      condition: priceCondition({ feed, threshold: px(threshold), op: o.op ?? 0, mode: 1, start: t + BigInt(o.startOffset ?? 0), deadline: t + 20_000n }),
      expiry: t + 20_000n + 6n * 3600n,
    });
  };
  const at = async (dt: number) => (await chain.now()) + BigInt(dt);

  beforeAll(async () => {
    resetIndexerState();
    resetWatcherState();
    chain = await bootChain();
    pg = await bootDb();
    deps = makeTestDeps(chain, pg.db);
  });
  afterAll(async () => {
    chain?.stop();
    await pg?.stop();
  });

  test("a brief touch between two polls is settled with the round that crossed", async () => {
    const feed = await chain.newFeed();
    await chain.push(feed, px(90), await at(-100));
    const id = await touch(feed, 100);
    await sync();
    await priceWatchTick(deps); // first sight of the feed
    expect(await statusOf(id)).toBe(Status.OPEN);
    await chain.push(feed, px(95), await at(10));
    const crossing = await chain.push(feed, px(105), await at(20));
    await chain.push(feed, px(85), await at(30)); // back below by the time the watcher looks
    await priceWatchTick(deps);
    expect(await statusOf(id)).toBe(Status.RELEASED);
    expect(await proofOf(id)).toBe(crossing);
  });

  test("a crossing before the window opens or after the deadline does not settle it", async () => {
    const feed = await chain.newFeed();
    await chain.push(feed, px(90), await at(-100));
    const early = await touch(feed, 100, { startOffset: 5000 }); // window opens in 5000 s
    const late = await touch(feed, 100); // window is 20000 s
    await sync();
    await priceWatchTick(deps);
    await chain.push(feed, px(120), await at(100)); // inside `late`'s window, before `early` opens
    await priceWatchTick(deps);
    expect(await statusOf(late)).toBe(Status.RELEASED);
    expect(await statusOf(early)).toBe(Status.OPEN);
    await chain.push(feed, px(120), await at(30_000)); // after both deadlines
    await priceWatchTick(deps);
    expect(await statusOf(early)).toBe(Status.OPEN);
  });

  test("across a phase change: the crossing is the first round of the new phase", async () => {
    const feed = await chain.newFeed();
    await chain.push(feed, px(90), await at(-100));
    const id = await touch(feed, 100, { op: 0 });
    await sync();
    await priceWatchTick(deps);
    await chain.push(feed, px(92), await at(10)); // last round of phase 1
    await chain.newPhase(feed);
    const first = await chain.push(feed, px(110), await at(20)); // first round of phase 2
    expect(first >> 64n).toBe(2n);
    await priceWatchTick(deps);
    expect(await statusOf(id)).toBe(Status.RELEASED);
    expect(await proofOf(id)).toBe(first);
  });

  test("a phase-0 feed (ids 191, 192, ...) works the same way", async () => {
    const feed = await chain.newFeed({ phase0: true, startAgg: 190n });
    expect(await chain.push(feed, px(90), await at(-100))).toBe(191n);
    const id = await touch(feed, 100, { op: 0 });
    await sync();
    await priceWatchTick(deps);
    const r = await chain.push(feed, px(130), await at(10));
    expect(r).toBe(192n);
    await priceWatchTick(deps);
    expect(await statusOf(id)).toBe(Status.RELEASED);
    expect(await proofOf(id)).toBe(192n);
  });

  test("a restart resumes from the stored cursor and still sees rounds printed while it was down", async () => {
    const feed = await chain.newFeed();
    await chain.push(feed, px(90), await at(-100));
    const id = await touch(feed, 100);
    await sync();
    await priceWatchTick(deps);
    const [cur] = await pg.db.select().from(cursors).where(eq(cursors.name, `watch:${feed.toLowerCase()}`));
    expect(cur).toBeDefined();
    resetWatcherState(); // process restart
    const crossing = await chain.push(feed, px(101), await at(10)); // printed while the watcher was down
    await chain.push(feed, px(80), await at(20));
    await priceWatchTick(deps);
    expect(await statusOf(id)).toBe(Status.RELEASED);
    expect(await proofOf(id)).toBe(crossing);
  });

  test("an escrow the indexer learns about late is checked against rounds the cursor already passed", async () => {
    const feed = await chain.newFeed();
    await chain.push(feed, px(90), await at(-100));
    const first = await touch(feed, 150); // never crosses
    await sync();
    await priceWatchTick(deps); // cursor now at the latest round
    const late = await touch(feed, 100); // created, but NOT indexed yet
    const crossing = await chain.push(feed, px(120), await at(10));
    await priceWatchTick(deps); // the watcher moves past `crossing` without knowing `late`
    expect(await statusOf(late)).toBe(Status.OPEN);
    await sync(); // the indexer catches up
    await priceWatchTick(deps);
    expect(await statusOf(late)).toBe(Status.RELEASED);
    expect(await proofOf(late)).toBe(crossing);
    expect(await statusOf(first)).toBe(Status.OPEN); // 120 never reached its 150 threshold
  });
});
