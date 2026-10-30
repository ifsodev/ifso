// R1-M8: stuck escrows step aside (per-escrow backoff) so they never hide the rows behind them.
import { beforeEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { loadEnv } from "../src/config/env";
import { Status } from "../src/core/types";
import { keeperTick, resetKeeperBackoff } from "../src/workers/keeper";
import type { Deps } from "../src/workers/deps";

const ZERO = "0x0000000000000000000000000000000000000000";

/** A keeper deps stub whose only non-empty query is the expired-refund pass (5th query of a tick is the last pass). */
function setup(stuck: number) {
  const sent: Array<{ functionName: string; args: unknown[] }> = [];
  const sims: bigint[] = [];
  const now = Date.now();
  const rows = [
    ...Array.from({ length: stuck }, (_, i) => ({ id: String(1000 + i), alt: ZERO, expiry: new Date(now - 10 * 86400_000 + i), status: Status.OPEN })),
    { id: "7", alt: ZERO, expiry: new Date(now - 3600_000), status: Status.OPEN },
  ];
  let call = 0;
  const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" as Address }, writeContract: async (req: { functionName: string; args: unknown[] }) => (sent.push(req), "0xabc" as Hex) };
  const deps = {
    env: loadEnv({ ESCROW_ADDRESS: "0x00000000000000000000000000000000000e5c20" }),
    log: () => {},
    alert: async () => true,
    db: {
      select: () => {
        let limit = Infinity;
        const q: any = {
          from: () => q,
          where: () => q,
          orderBy: () => q,
          limit: (n: number) => ((limit = n), q),
          then: (res: (v: unknown[]) => unknown) => res(call++ % 5 === 3 ? [...rows].sort((a, b) => a.expiry.getTime() - b.expiry.getTime()).slice(0, limit) : []),
        };
        return q;
      },
      insert: () => ({ values: async () => {} }),
    },
    clients: {
      chain: { id: 4663 },
      escrow: "0x00000000000000000000000000000000000e5c20",
      keeper: wallet,
      publicClient: {
        getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
        simulateContract: async (req: { functionName: string; args: unknown[] }) => {
          sims.push(req.args[0] as bigint);
          if ((req.args[0] as bigint) >= 1000n) throw new Error("Blocked()");
          return { request: req };
        },
        estimateContractGas: async () => 100_000n,
        getGasPrice: async () => 1_000_000n,
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
    },
  } as unknown as Deps;
  return { deps, sent, sims };
}

describe("R1-M8: keeper sweeps step past failing rows", () => {
  beforeEach(resetKeeperBackoff);

  test("250 stuck escrows (more than one scan window): the honest one is reached after the stuck ones back off", async () => {
    const { deps, sent } = setup(250);
    await keeperTick(deps); // looks at the first 200, all fail and back off
    expect(sent.some((s) => s.args[0] === 7n)).toBe(false);
    await keeperTick(deps); // the window now starts past them
    expect(sent.filter((s) => s.functionName === "refund").map((s) => s.args[0])).toContain(7n);
  });

  test("a failing escrow is not simulated again on the next sweep", async () => {
    const { deps, sims } = setup(3);
    await keeperTick(deps);
    const first = sims.filter((id) => id >= 1000n).length;
    expect(first).toBe(3);
    await keeperTick(deps);
    expect(sims.filter((id) => id >= 1000n).length).toBe(3); // unchanged: still in backoff
  });

  test("backoff is per escrow and lifts: after it expires the row is tried again", async () => {
    const { deps, sims } = setup(1);
    await keeperTick(deps);
    resetKeeperBackoff(); // stands in for the backoff window passing
    await keeperTick(deps);
    expect(sims.filter((id) => id === 1000n).length).toBe(2);
  });
});
