// Audit L-4 regression (PoC LW-3, inverted): waits (noteWait) and failures (noteFailure) used to share one counter, so
// an AT_DEADLINE row that waited through an off-hours hold and then failed ONE send was parked for the 6 h failure
// maximum instead of 2 min. The counters are separate now: the first failure after any number of waits backs off 2 min.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Address, Hex } from "viem";
import { loadEnv } from "../src/config/env";
import { escrows } from "../src/db/schema";
import { keeperTick, resetKeeperBackoff } from "../src/workers/keeper";
import type { Deps } from "../src/workers/deps";

const FEED = "0x00000000000000000000000000000000000000f1" as Address;
const T0 = 1_900_000_000_000; // ms
const D = BigInt(T0 / 1000); // deadline

function setup() {
  let nextPrinted = false;
  let failNext = false;
  const sims: number[] = [];
  const row = {
    id: "7", twoSided: false, accepted: false, activeFrom: new Date(T0 - 86400_000), expiry: new Date(T0 + 10 * 86400_000),
    condition: { kind: 2, mode: 0, op: 0, source: 0, target: FEED, stockToken: "0x0000000000000000000000000000000000000000", key: "0x" + "00".repeat(32), threshold: "100", multiplier: "0", outcomeMask: "0", start: "0", deadline: String(D), maxStale: 60, holdWindow: 3 * 86400 },
  };
  let plainEscrowSelect = 0;
  const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" as Address }, writeContract: async () => "0xabc" as Hex };
  const rounds: Record<string, [bigint, bigint, bigint, bigint, bigint]> = {
    "5": [5n, 90n, 0n, D - 3600n, 5n],
    "6": [6n, 150n, 0n, D + 86400n, 6n],
  };
  const deps = {
    env: loadEnv({ ESCROW_ADDRESS: "0x00000000000000000000000000000000000e5c20" }),
    log: () => {},
    alert: async () => true,
    db: {
      select: (fields?: unknown) => {
        let table: unknown;
        const q: any = {
          from: (t: unknown) => ((table = t), q), where: () => q, orderBy: () => q, limit: () => q,
          then: (res: (v: unknown[]) => unknown) => {
            if (table === escrows && fields === undefined) return res(plainEscrowSelect++ % 2 === 1 ? [row] : []); // 2nd plain select = settlePrice
            return res([]);
          },
        };
        return q;
      },
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
    },
    clients: {
      chain: { id: 4663 },
      escrow: "0x00000000000000000000000000000000000e5c20",
      keeper: wallet,
      publicClient: {
        getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
        readContract: async (r: { functionName: string; args?: unknown[] }) => {
          if (r.functionName === "latestRoundData") return nextPrinted ? rounds["6"] : rounds["5"];
          if (r.functionName === "getRoundData") {
            const id = String(r.args![0]);
            if (id === "6" && !nextPrinted) throw new Error("no round");
            if (!rounds[id]) throw new Error("no round");
            return rounds[id];
          }
          throw new Error("unexpected " + r.functionName);
        },
        simulateContract: async (req: unknown) => {
          sims.push(Date.now());
          if (failNext) { failNext = false; throw new Error("transient: header not found"); }
          return { request: req };
        },
        estimateContractGas: async () => 100_000n,
        getGasPrice: async () => 1_000_000n,
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
    },
  } as unknown as Deps;
  return { deps, sims, print: () => (nextPrinted = true), failOnce: () => (failNext = true) };
}

describe("audit L-4: waits and failures back off on separate counters", () => {
  afterEach(() => { setSystemTime(); resetKeeperBackoff(); });

  test("control: a row with no waits that fails once is retried after ~2 min", async () => {
    setSystemTime(new Date(T0 + 60_000));
    const s = setup();
    s.print(); s.failOnce();
    await keeperTick(s.deps); // fails once
    setSystemTime(new Date(T0 + 60_000 + 3 * 60_000));
    await keeperTick(s.deps);
    expect(s.sims.length).toBe(2); // retried
  });

  test("12 waits during the hold, then one failed send -> retried ~3 min later, like a fresh row", async () => {
    let t = T0 + 60_000;
    setSystemTime(new Date(t));
    const s = setup();
    for (let i = 0; i < 12; i++) { await keeperTick(s.deps); t += 31 * 60_000; setSystemTime(new Date(t)); }
    expect(s.sims.length).toBe(0); // only waits so far
    s.print(); s.failOnce();
    await keeperTick(s.deps);
    expect(s.sims.length).toBe(1); // the one failed send
    setSystemTime(new Date(t + 3 * 60_000));
    await keeperTick(s.deps);
    expect(s.sims.length).toBe(2); // retried after the 2 min failure base, not parked for the 6 h maximum
  });
});
