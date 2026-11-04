// Oracle staleness and large outflow alerts (audit Path item 2). Pure checks first, then the two monitors against a stub
// chain client (oracle) and a real Postgres (outflow, read from the indexed chain_events rows).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Address } from "viem";
import { loadEnv } from "../src/config/env";
import type { FeedInfo } from "../src/config/chain";
import { isStockFeedSession, stockFeedOpenSeconds } from "../src/core/price";
import { chainEvents, cursors } from "../src/db/schema";
import { makeAlert } from "../src/ops/alerts";
import { checkOracles, checkOutflow, feedProblem, outflowAlerts, outflowsOf, type Outflow } from "../src/ops/monitors";
import type { Deps } from "../src/workers/deps";
import { bootDb, havePostgres, type TestDb } from "./helpers/chain";

setDefaultTimeout(60_000);
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const ETH: FeedInfo = { ticker: "ETH", feed: A(0xe7), isStock: false, heartbeat: 86400 };
const SPY: FeedInfo = { ticker: "SPY", feed: A(0x5b), stockToken: A(0x5c), isStock: true, heartbeat: 86400 };
const MARGIN = 3600;

describe("stock feed session (24/5, New York time)", () => {
  test("open Sunday 20:00 ET to Friday 20:00 ET", () => {
    expect(isStockFeedSession(unix("2026-10-24T12:00:00Z"))).toBe(false); // Saturday
    expect(isStockFeedSession(unix("2026-10-25T23:59:00Z"))).toBe(false); // Sunday 19:59 EDT
    expect(isStockFeedSession(unix("2026-10-26T00:00:00Z"))).toBe(true); //  Sunday 20:00 EDT
    expect(isStockFeedSession(unix("2026-10-23T23:59:00Z"))).toBe(true); //  Friday 19:59 EDT
    expect(isStockFeedSession(unix("2026-10-24T00:00:00Z"))).toBe(false); // Friday 20:00 EDT
    expect(isStockFeedSession(unix("2026-12-05T00:30:00Z"))).toBe(true); //  Friday 19:30 EST
    expect(isStockFeedSession(unix("2026-12-05T01:00:00Z"))).toBe(false); // Friday 20:00 EST
  });
  test("open seconds skip the weekend", () => {
    // Friday 19:30 EDT -> Monday 10:00 EDT: 30 minutes on Friday + 14 hours from Sunday 20:00
    expect(stockFeedOpenSeconds(unix("2026-10-23T23:30:00Z"), unix("2026-10-26T14:00:00Z"))).toBe(14.5 * 3600);
    expect(stockFeedOpenSeconds(unix("2026-10-24T01:00:00Z"), unix("2026-10-25T20:00:00Z"))).toBe(0);
  });
});

describe("feedProblem", () => {
  const round = (answer: bigint, updatedAt: number) => ({ answer, updatedAt: BigInt(updatedAt) });
  test("crypto feed: stale past heartbeat plus margin, fresh inside it", () => {
    const now = unix("2026-10-24T12:00:00Z");
    expect(feedProblem(ETH, round(2000_00000000n, now - 86400 - MARGIN - 1), now, MARGIN)?.kind).toBe("stale");
    expect(feedProblem(ETH, round(2000_00000000n, now - 86400 - MARGIN + 60), now, MARGIN)).toBeUndefined();
    expect(feedProblem(ETH, round(2000_00000000n, now - 3600), now, MARGIN)).toBeUndefined();
  });
  test("stock feed: no staleness alert while the market is closed", () => {
    const now = unix("2026-10-24T12:00:00Z"); // Saturday
    expect(feedProblem(SPY, round(600_00000000n, unix("2026-10-21T12:00:00Z")), now, MARGIN)).toBeUndefined();
  });
  test("stock feed: weekend hours do not count once the market reopens", () => {
    // last print Friday 19:30 EDT, now Monday 10:00 EDT: 62.5 wall hours, 14.5 open hours
    expect(feedProblem(SPY, round(600_00000000n, unix("2026-10-23T23:30:00Z")), unix("2026-10-26T14:00:00Z"), MARGIN)).toBeUndefined();
  });
  test("stock feed: stale after 25 open hours", () => {
    const p = feedProblem(SPY, round(600_00000000n, unix("2026-10-20T08:00:00Z")), unix("2026-10-21T10:00:00Z"), MARGIN);
    expect(p?.kind).toBe("stale");
    expect(p?.text).toContain("holiday");
  });
  test("zero or negative answer alerts at any time, market open or not", () => {
    const sat = unix("2026-10-24T12:00:00Z");
    expect(feedProblem(SPY, round(-1n, sat - 60), sat, MARGIN)?.kind).toBe("bad-answer");
    expect(feedProblem(ETH, round(0n, sat - 60), sat, MARGIN)?.kind).toBe("bad-answer");
  });
  test("alert text is plain: no em dashes", () => {
    const now = unix("2026-10-21T10:00:00Z");
    for (const p of [feedProblem(SPY, round(1n, now - 30 * 3600), now, MARGIN), feedProblem(ETH, round(-5n, now), now, MARGIN)]) expect(p!.text).not.toMatch(/[–—]/);
  });
});

describe("checkOracles (stub chain)", () => {
  test("one alert per feed and cause; fresh feeds stay quiet; a failed read is reported", async () => {
    const now = new Date("2026-10-21T10:00:00Z");
    const t = Math.floor(now.getTime() / 1000);
    const BAD: FeedInfo = { ticker: "NVDA", feed: A(0x4e), isStock: true, heartbeat: 86400 };
    const GONE: FeedInfo = { ticker: "AAPL", feed: A(0xaa), isStock: true, heartbeat: 86400 };
    const rounds: Record<string, [bigint, bigint, bigint, bigint, bigint]> = {
      [ETH.feed]: [1n, 2000_00000000n, 0n, BigInt(t - 2 * 86400), 1n], // stale
      [SPY.feed]: [1n, 600_00000000n, 0n, BigInt(t - 600), 1n], //        fresh
      [BAD.feed]: [1n, -3n, 0n, BigInt(t - 600), 1n], //                  negative
    };
    const alerts: [string, string][] = [];
    const deps = {
      env: loadEnv({}),
      log: () => {},
      clients: { publicClient: { readContract: async ({ address }: { address: Address }) => { if (!rounds[address]) throw new Error("execution reverted"); return rounds[address]; } } },
    } as unknown as Deps;
    await checkOracles(deps, async (c, x) => (alerts.push([c, x]), true), now, [ETH, SPY, BAD, GONE]);
    expect(alerts.map(([c]) => c).sort()).toEqual(["oracle-bad-answer-NVDA", "oracle-read-AAPL", "oracle-stale-ETH"]);
  });
});

// ---------------------------------------------------------------- outflow
const ESCROW = A(0xe5c);
const ev = (name: string, args: Record<string, unknown>, block: bigint, logIndex = 0) => ({ name, args, blockNumber: block, logIndex, txHash: `0x${block.toString(16).padStart(62, "0")}${logIndex.toString(16).padStart(2, "0")}`, escrowId: String(args.id) });
const usdg = (n: number) => String(BigInt(n) * 1_000_000n);

describe("outflowsOf / outflowAlerts", () => {
  test("every event that sends USDG out of the escrow counts; a void side with no address does not", () => {
    const out = [
      ev("Released", { id: "1", to: A(1), amount: usdg(10) }, 1n),
      ev("Returned", { id: "2", to: A(2), amount: usdg(20), reason: 1 }, 1n, 1),
      ev("Cancelled", { id: "3", to: A(3), amount: usdg(30) }, 1n, 2),
      ev("VoidClaimed", { id: "4", to: A(4), amount: usdg(40) }, 1n, 3),
      ev("Voided", { id: "5", senderTo: A(5), senderAmount: usdg(50), counterTo: A(0), counterAmount: usdg(50) }, 1n, 4),
      ev("Claimed", { id: "6", recipient: A(6) }, 1n, 5),
    ].flatMap(outflowsOf);
    expect(out.map((o) => o.amount)).toEqual([10n, 20n, 30n, 40n, 50n].map((n) => n * 1_000_000n));
  });
  const env = loadEnv({});
  const flows = (amounts: number[]): Outflow[] => amounts.flatMap((a, i) => outflowsOf(ev("Released", { id: String(i), to: A(i + 1), amount: usdg(a) }, BigInt(i + 1))));
  test("defaults follow the 1,000 USDG launch cap", () => {
    expect(env.LARGE_RELEASE_USDG).toBe(1000);
    expect(env.OUTFLOW_WINDOW_USDG).toBe(5000);
    expect(env.OUTFLOW_WINDOW_MINUTES).toBe(60);
  });
  test("under the window level: no alert", () => {
    expect(outflowAlerts(flows([900, 900, 900, 900, 900]), [], env)).toEqual([]);
  });
  test("over the window level: one alert for the window", () => {
    const a = outflowAlerts(flows([1000, 1000, 1000, 1000, 1000, 1]), [], env);
    expect(a.map((x) => x.cause)).toEqual(["outflow-window"]);
    expect(a[0]!.text).toContain("5001");
    expect(a[0]!.text).not.toMatch(/[–—]/);
  });
  test("a single release above the level: one alert for that release, none for one at the level", () => {
    const f = flows([1000, 1500]);
    const a = outflowAlerts(f, f, env);
    expect(a.map((x) => x.cause)).toEqual([`large-release-${f[1]!.txHash}-${f[1]!.logIndex}`]);
    expect(a[0]!.text).toContain("1500");
  });
});

describe.skipIf(!havePostgres())("checkOutflow (real Postgres, indexed events)", () => {
  let pg: TestDb;
  beforeAll(async () => {
    pg = await bootDb();
  });
  afterAll(async () => pg?.stop());

  test("reads the escrow's indexed events: window total, each large release once, nothing past the indexer cursor", async () => {
    const now = new Date("2026-10-21T10:00:00Z");
    const ago = (m: number) => new Date(now.getTime() - m * 60_000);
    const row = (e: ReturnType<typeof ev>, blockTime: Date | null, address: string = ESCROW) => ({ ...e, address, blockTime });
    await pg.db.insert(chainEvents).values([
      row(ev("Released", { id: "1", to: A(1), amount: usdg(2000) }, 10n), ago(200)), // outside the window
      row(ev("Released", { id: "2", to: A(2), amount: usdg(1800) }, 20n), ago(30)),
      row(ev("Returned", { id: "3", to: A(3), amount: usdg(1500), reason: 2 }, 21n), ago(20)),
      row(ev("Released", { id: "9", to: A(9), amount: usdg(9000) }, 22n), ago(10), A(0xbad)), // another contract
      row(ev("Released", { id: "4", to: A(4), amount: usdg(1900) }, 30n), ago(5)), //  past the indexer cursor: not yet final
    ]);
    await pg.db.insert(cursors).values({ name: "main", block: 25n });
    const alerts: [string, string][] = [];
    const deps = { env: loadEnv({ OUTFLOW_WINDOW_USDG: "3000" }), db: pg.db, log: () => {}, clients: { escrow: ESCROW } } as unknown as Deps;
    const fn = async (c: string, t: string) => (alerts.push([c, t]), true);
    await checkOutflow(deps, fn, now);
    expect(alerts.map(([c]) => c).sort()).toEqual(["large-release-" + ev("Released", {}, 20n).txHash + "-0", "large-release-" + ev("Returned", {}, 21n).txHash + "-0", "outflow-window"].sort());
    expect(alerts.find(([c]) => c === "outflow-window")![1]).toContain("3300");

    // next minute: the same releases are not raised again; the newly final one is
    alerts.length = 0;
    await pg.db.update(cursors).set({ block: 30n }).where(eq(cursors.name, "main"));
    await checkOutflow(deps, fn, new Date(now.getTime() + 60_000));
    expect(alerts.filter(([c]) => c.startsWith("large-release-")).map(([c]) => c)).toEqual(["large-release-" + ev("Released", {}, 30n).txHash + "-0"]);
  });
});

describe.skipIf(!havePostgres())("audit I-10: the outflow cursor waits for delivery", () => {
  let pg: TestDb;
  beforeAll(async () => {
    pg = await bootDb();
  });
  afterAll(async () => pg?.stop());

  test("a failed send holds the cursor and the release is raised again; a delivered or unarmed send moves it", async () => {
    const now = new Date("2026-10-21T10:00:00Z");
    const big = ev("Released", { id: "7", to: A(7), amount: usdg(1800) }, 40n);
    await pg.db.insert(chainEvents).values([{ ...big, address: ESCROW, blockTime: new Date(now.getTime() - 60_000) }]);
    await pg.db.insert(cursors).values([{ name: "main", block: 45n }, { name: "outflow-watch", block: 39n }]);
    const deps = { env: loadEnv({ OUTFLOW_WINDOW_USDG: "100000" }), db: pg.db, log: () => {}, clients: { escrow: ESCROW } } as unknown as Deps;
    const outCursor = async () => (await pg.db.select().from(cursors).where(eq(cursors.name, "outflow-watch")))[0]!.block;
    const cause = `large-release-${big.txHash}-0`;

    const tries: string[] = [];
    await checkOutflow(deps, async (c) => (tries.push(c), false), now); // Telegram down
    expect(tries).toEqual([cause]);
    expect(await outCursor()).toBe(39n);

    await checkOutflow(deps, async (c) => (tries.push(c), true), new Date(now.getTime() + 60_000)); // sent
    expect(tries).toEqual([cause, cause]);
    expect(await outCursor()).toBe(45n);

    // unarmed (log-only) counts as delivered: an unarmed server never stalls on the same block
    const big2 = ev("Released", { id: "8", to: A(8), amount: usdg(1800) }, 50n);
    await pg.db.insert(chainEvents).values([{ ...big2, address: ESCROW, blockTime: now }]);
    await pg.db.update(cursors).set({ block: 55n }).where(eq(cursors.name, "main"));
    const logs: string[] = [];
    await checkOutflow(deps, makeAlert({ armed: false, log: (m) => logs.push(m) }), new Date(now.getTime() + 120_000));
    expect(logs).toContain("alert (not sent: unarmed)");
    expect(await outCursor()).toBe(55n);
  });
});
