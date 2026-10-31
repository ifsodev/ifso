// Bugs found by the fork run (docs/research/fork-run-2026-10-31.md), each with the failing test first.
import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter } from "../src/api/router";
import { loadEnv } from "../src/config/env";
import { Kind } from "../src/core/types";
import type { Deps } from "../src/workers/deps";

const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const SENDER = "0x1111111111111111111111111111111111111111" as Address;
const REFEREE = "0x3333333333333333333333333333333333333333" as Address;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as Address;

const buildDeps = () =>
  ({
    env: loadEnv({ ESCROW_ADDRESS: ESCROW }),
    log: () => {},
    db: {},
    clients: {
      chain: { id: 4663 },
      escrow: ESCROW,
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      publicClient: { readContract: async ({ functionName }: { functionName: string }) => (functionName === "feeFor" ? 250_000n : 0n) },
    },
  }) as unknown as Deps;
const caller = () => appRouter.createCaller({ deps: buildDeps(), limiter: new RateLimiter(), ip: "203.0.113.7", country: "DE" });

describe("fork run: a referee typed as an address in the text", () => {
  test("build uses the 0x referee from the text (the parser already read it) without a separate referee field", async () => {
    const a = (await caller().build({ text: `/ifso ${RECIPIENT} 20 if referee ${REFEREE} decides`, sender: SENDER })) as { params: { condition: { kind: number; target: string } } };
    expect(a.params.condition.kind).toBe(Kind.APPROVE);
    expect(a.params.condition.target.toLowerCase()).toBe(REFEREE);
  });
  test("an explicit referee field still wins over the text", async () => {
    const other = "0x4444444444444444444444444444444444444444" as Address;
    const a = (await caller().build({ text: `/ifso ${RECIPIENT} 20 if referee ${REFEREE} decides`, sender: SENDER, referee: other })) as { params: { condition: { target: string } } };
    expect(a.params.condition.target.toLowerCase()).toBe(other);
  });
});
