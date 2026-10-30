// Keeper: PRICE escrows on a Stock Token with an announced multiplier change settle before it takes effect (R2-L1).
import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { pendingEffectiveAt, prioritiseBySchedule } from "../src/workers/keeper";
import type { Deps } from "../src/workers/deps";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";

const depsWith = (eff: Record<string, bigint | "revert">) =>
  ({ clients: { publicClient: { readContract: async (r: { address: string }) => { const v = eff[r.address.toLowerCase()]; if (v === undefined || v === "revert") throw new Error("revert"); return v; } } } }) as unknown as Deps;

describe("multiplier schedule priority", () => {
  test("only a schedule still in the future is pending", async () => {
    const d = depsWith({ [A]: 2000n, [B]: 900n, [C]: "revert", });
    expect(await pendingEffectiveAt(d, A as Address, 1000n)).toBe(2000n);
    expect(await pendingEffectiveAt(d, B as Address, 1000n)).toBeUndefined(); // already in force
    expect(await pendingEffectiveAt(d, C as Address, 1000n)).toBeUndefined(); // unreadable
  });
  test("rows on a token with a pending change go first, soonest change first; others keep their order", () => {
    const rows = [{ id: 1, t: B }, { id: 2, t: undefined }, { id: 3, t: A }, { id: 4, t: C }, { id: 5, t: B }];
    const pending = new Map<string, bigint>([[A, 3000n], [C, 2000n]]);
    const out = prioritiseBySchedule(rows, (r) => r.t, pending).map((r) => r.id);
    expect(out).toEqual([4, 3, 1, 2, 5]);
  });
  test("no pending schedules keeps the deadline order", () => {
    const rows = [{ id: 1, t: A }, { id: 2, t: B }];
    expect(prioritiseBySchedule(rows, (r) => r.t, new Map()).map((r) => r.id)).toEqual([1, 2]);
  });
});
