// The OUTCOME expiry minimum comes from the evaluator and resolver, never a constant in the app.
import { describe, expect, test } from "bun:test";
import { outcomeMinSpan } from "../src/api/router";
import type { Deps } from "../src/workers/deps";

describe("outcomeMinSpan", () => {
  test("PROPOSAL_GRACE + MIN_CLAIM_WINDOW + dispute + panel, as read", async () => {
    const vals: Record<string, bigint> = { PROPOSAL_GRACE: 172800n, MIN_CLAIM_WINDOW: 86400n, disputeWindow: 86400n, panelWindow: 172800n };
    const deps = { clients: { escrow: "0x00000000000000000000000000000000000e5c20", evaluator: "0x00000000000000000000000000000000000e7a10", publicClient: { readContract: async (r: { functionName: string }) => vals[r.functionName] } } } as unknown as Deps;
    expect(await outcomeMinSpan(deps, "0x00000000000000000000000000000000000000dd")).toBe(172800 + 86400 + 86400 + 172800);
    vals.PROPOSAL_GRACE = 0n; // a different on-chain value is followed
    expect(await outcomeMinSpan(deps, "0x00000000000000000000000000000000000000dd")).toBe(86400 + 86400 + 172800);
  });
});
