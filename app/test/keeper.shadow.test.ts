// R3: with KEEPER_SHADOW=1 the keeper and the price watcher decide, simulate (eth_call) and log, and never send.
// 50 generated escrows (TIME, PRICE AT_DEADLINE with and without a phase change and phase-0 feeds, TOUCH, and
// undecided escrows that expire) are checked at four chain times. Every decision must agree with the eth_call
// answer (send <=> the call succeeds) and, where the evaluator returns a verdict, with that verdict. Real contracts
// on anvil port 8745 + Postgres 5442. Skips when they are missing.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { keccak256, toHex, type Address } from "viem";
import { relayTxs } from "../src/db/schema";
import { indexerTick, resetIndexerState } from "../src/workers/indexer";
import { keeperTick } from "../src/workers/keeper";
import { priceWatchTick } from "../src/workers/priceWatcher";
import { approveCondition, bootChain, bootDb, haveAnvil, havePostgres, makeTestDeps, priceCondition, timeCondition, type TestChain, type TestDb } from "./helpers/chain";
import type { Deps } from "../src/workers/deps";
import type { Condition } from "../src/core/types";

setDefaultTimeout(300_000);

describe.skipIf(!haveAnvil() || !havePostgres())("keeper shadow mode", () => {
  let chain: TestChain;
  let pg: TestDb;
  let deps: Deps;
  const logs: Array<{ msg: string; extra: Record<string, unknown> }> = [];
  // mulberry32: small, seeded, well mixed
  const prng = ((a: number) => () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  })(20261030);
  const rnd = (n: number) => Math.floor(prng() * n);

  beforeAll(async () => {
    resetIndexerState();
    chain = await bootChain();
    pg = await bootDb();
    deps = makeTestDeps(chain, pg.db, { KEEPER_SHADOW: "1" }, (msg, extra) => void logs.push({ msg, extra: extra ?? {} }));
  });
  afterAll(async () => {
    chain?.stop();
    await pg?.stop();
  });

  test("50 generated cases: every decision equals the eth_call answer at four chain times, and nothing is sent", async () => {
    const t0 = await chain.now();
    let n = 0;
    const kinds: Record<string, number> = {};
    const note = (k: string) => ((kinds[k] = (kinds[k] ?? 0) + 1), n++);
    const salt = () => keccak256(toHex(`case-${n}-${rnd(1e9)}`));

    for (let i = 0; i < 50; i++) {
      const m = i % 10; // 0-5 price at deadline (30), 6-7 touch (10), 8 time (5), 9 approve (5)
      const shape = m <= 5 ? 0 : m <= 7 ? 3 : m === 8 ? 2 : 4;
      const deadline = t0 + 3600n + BigInt(rnd(7200));
      if (shape === 2) {
        await chain.create(chain.sender, { condition: timeCondition(deadline), expiry: deadline + 86400n + BigInt(rnd(86400)), salt: salt() });
        note("time");
      } else if (shape === 4) {
        await chain.create(chain.sender, { condition: approveCondition(chain.deployer.address), expiry: t0 + 4000n + BigInt(rnd(100_000)), salt: salt() });
        note("approve");
      } else if (shape === 3) {
        const feed = await chain.newFeed({ phase0: rnd(2) === 0, startAgg: rnd(2) === 0 ? 190n : undefined });
        const start = t0;
        let t = Number(t0) + 10;
        for (let k = 0; k < 2 + rnd(5); k++) {
          t += 100 + rnd(3000);
          await chain.push(feed, BigInt(80 + rnd(40)) * 100_000_000n, BigInt(t));
        }
        if (rnd(2) === 0) await chain.newPhase(feed);
        t += 100 + rnd(3000);
        await chain.push(feed, BigInt(80 + rnd(40)) * 100_000_000n, BigInt(t));
        const c: Condition = priceCondition({ feed, threshold: BigInt(90 + rnd(20)) * 100_000_000n, op: rnd(2), mode: 1, start, deadline: t0 + 3600n + BigInt(rnd(20_000)) });
        await chain.create(chain.sender, { condition: c, expiry: c.deadline + 6n * 3600n + BigInt(rnd(86400)), salt: salt() });
        note("touch");
      } else {
        const feed = await chain.newFeed({ phase0: rnd(3) === 0, startAgg: rnd(3) === 0 ? 190n : undefined });
        const hold = 3600 + rnd(86400);
        const maxStale = 300 + rnd(7000);
        let t = Number(deadline) - 30_000;
        const before = rnd(4);
        for (let k = 0; k < before; k++) {
          t += rnd(9000);
          if (t >= Number(deadline)) break;
          await chain.push(feed, BigInt(80 + rnd(40)) * 100_000_000n, BigInt(t));
        }
        if (rnd(3) === 0) await chain.newPhase(feed);
        const after = rnd(3);
        t = Number(deadline) + 1;
        for (let k = 0; k < after; k++) {
          t += 1 + rnd(hold * 2);
          await chain.push(feed, BigInt(80 + rnd(40)) * 100_000_000n, BigInt(t));
        }
        const c = priceCondition({ feed, threshold: BigInt(90 + rnd(20)) * 100_000_000n, op: rnd(2), deadline, maxStale, holdWindow: hold });
        await chain.create(chain.sender, { condition: c, expiry: deadline + BigInt(hold) + 6n * 3600n + BigInt(rnd(86400)), salt: salt() });
        note("price");
      }
    }
    expect(n).toBe(50);

    const checkpoints = [t0 + 1800n, t0 + 11_000n, t0 + 129_600n, t0 + 5n * 86400n];
    for (const at of checkpoints) {
      await chain.warpTo(at);
      await indexerTick(deps, async () => {});
      await keeperTick(deps);
      await priceWatchTick(deps);
    }

    const shadow = logs.filter((l) => l.msg === "shadow");
    expect(shadow.length).toBeGreaterThanOrEqual(50);
    const mismatches = shadow.filter((l) => (l.extra.decision as { send: boolean }).send !== (l.extra.ethCall === "ok"));
    expect(mismatches).toEqual([]);
    expect(logs.filter((l) => l.msg === "shadow MISMATCH")).toEqual([]);
    const verdicts = logs.filter((l) => l.msg === "shadow verdict" && l.extra.decided !== undefined);
    expect(verdicts.length).toBeGreaterThan(10);
    expect(verdicts.filter((v) => v.extra.decided !== v.extra.ethCall)).toEqual([]);
    expect(new Set(verdicts.map((v) => v.extra.decided)).size).toBeGreaterThanOrEqual(2); // not all one verdict
    // a healthy spread: some decisions send, some hold
    const sends = shadow.filter((l) => (l.extra.decision as { send: boolean }).send).length;
    expect(sends).toBeGreaterThan(20);
    expect(shadow.length - sends).toBeGreaterThan(0);
    const byKind = new Set(shadow.map((l) => l.extra.kind));
    for (const k of ["settle", "refund", "settle-touch"]) expect(byKind.has(k)).toBe(true);

    // nothing was sent: no keeper transaction, no relay_txs row
    expect(await chain.pc.getTransactionCount({ address: deps.clients.keeper!.account!.address })).toBe(0);
    expect(await pg.db.select().from(relayTxs)).toEqual([]);
    console.log(`shadow: verdicts ${JSON.stringify([...new Set(verdicts.map((v) => v.extra.decided))])}; ${shadow.length} comparisons (${sends} send, ${shadow.length - sends} hold), ${verdicts.length} verdict checks, mix ${JSON.stringify(kinds)}`);
  }, 900_000); // own timeout: 50 cases of chain writes take minutes when the host is busy
});
export type { Address };
