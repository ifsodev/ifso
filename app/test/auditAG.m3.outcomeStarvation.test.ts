// Audit M-3 regression (PoC LW-2, inverted): OUTCOME rows on a question that is not final used to never step aside,
// so 500 funded OUTCOME escrows with an earlier expiry hid every row behind them from the keeper, tick after tick.
// They now back off (noteWait) and the scan page grows past them, so the payable row is settled on the next tick.
import { beforeEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { loadEnv } from "../src/config/env";
import { keeperTick, resetKeeperBackoff } from "../src/workers/keeper";
import type { Deps } from "../src/workers/deps";

const RESOLVER = "0x00000000000000000000000000000000000000r1".replace("r1", "a1") as Address;
const QA = ("0x" + "aa".repeat(32)) as Hex; // attacker's question: not final (state OPEN=1)
const QV = ("0x" + "bb".repeat(32)) as Hex; // victim's question: FINAL (4)

function setup(spam: number) {
  const sent: bigint[] = [];
  const now = Date.now();
  const cond = { kind: 4, target: RESOLVER };
  const rows = [
    ...Array.from({ length: spam }, (_, i) => ({ id: String(1000 + i), questionId: QA, condition: cond, twoSided: false, accepted: false, expiry: new Date(now + 6 * 86400_000 + i) })),
    { id: "7", questionId: QV, condition: cond, twoSided: false, accepted: false, expiry: new Date(now + 7 * 86400_000) },
  ];
  let call = 0;
  const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" as Address }, writeContract: async (req: { args: unknown[] }) => (sent.push(req.args[0] as bigint), "0xabc" as Hex) };
  const deps = {
    env: loadEnv({ ESCROW_ADDRESS: "0x00000000000000000000000000000000000e5c20" }),
    log: () => {},
    alert: async () => true,
    db: {
      select: () => {
        let limit = Infinity;
        const q: any = {
          from: () => q, where: () => q, orderBy: () => q,
          limit: (n: number) => ((limit = n), q),
          then: (res: (v: unknown[]) => unknown) => res(call++ % 6 === 2 ? [...rows].sort((a, b) => a.expiry.getTime() - b.expiry.getTime()).slice(0, limit) : []),
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
        readContract: async (r: { functionName: string; args: unknown[] }) => (r.functionName === "outcomeOf" ? [r.args[0] === QV ? 4 : 1, 1] : undefined),
        simulateContract: async (req: unknown) => ({ request: req }),
        estimateContractGas: async () => 100_000n,
        getGasPrice: async () => 1_000_000n,
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
    },
  } as unknown as Deps;
  return { deps, sent };
}

describe("audit M-3: OUTCOME pass is not starved by rows on an open question", () => {
  beforeEach(resetKeeperBackoff);
  test("control: 499 pending rows ahead -> victim settled on the first tick", async () => {
    const { deps, sent } = setup(499);
    await keeperTick(deps);
    expect(sent).toContain(7n);
  });
  test("500 pending rows ahead -> victim settled by the second tick, and only once", async () => {
    const { deps, sent } = setup(500);
    await keeperTick(deps);
    await keeperTick(deps);
    expect(sent).toEqual([7n]); // nothing is ever sent for the rows on the open question
  });
  test("2,000 pending rows ahead -> victim still reached within 5 ticks (500 more rows looked at per tick)", async () => {
    const { deps, sent } = setup(2000);
    for (let i = 0; i < 5; i++) await keeperTick(deps);
    expect(sent).toContain(7n);
  });
});
