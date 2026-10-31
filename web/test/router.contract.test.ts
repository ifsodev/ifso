// The real API router (not a copy of its answers) feeds the site's create flow: what `build` returns must pass the
// site's verification, and the typed data it hands over must be what the site signs.
import { describe, expect, test } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { appRouter } from "../../app/src/api/router";
import { RateLimiter } from "../../app/src/api/rateLimit";
import { loadEnv } from "../../app/src/config/env";
import { buildAndVerify, signAndSubmit } from "@/lib/ifso/create";
import type { Api } from "@/lib/ifso/api";

const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const user = privateKeyToAccount(("0x" + "0a".repeat(32)) as Hex); // test-key

const sent: Record<string, unknown>[] = [];
const deps = {
  env: loadEnv({ ESCROW_ADDRESS: ESCROW }),
  log: () => {},
  db: {},
  clients: {
    chain: { id: 4663 },
    escrow: ESCROW,
    usdg: USDG,
    relayer: { account: { address: "0x00000000000000000000000000000000000000ee" }, writeContract: async () => "0xabc" as Hex },
    publicClient: { readContract: async () => 250_000n, simulateContract: async (r: unknown) => ({ request: r }), estimateContractGas: async () => 100_000n, getGasPrice: async () => 1_000_000n, waitForTransactionReceipt: async () => ({ status: "success" }) },
  },
};
const caller = appRouter.createCaller({ deps: deps as never, limiter: new RateLimiter(), ip: "203.0.113.7", country: "DE" });

describe("site <-> real router", () => {
  test("parse then build for a date payment verifies, signs and submits", async () => {
    const text = "/ifso link 20 on 2026-12-01";
    const parsed = await caller.parse({ text });
    expect(parsed.ok).toBe(true);
    const api = {
      build: async (i: never) => (await caller.build(i)) as never,
      submit: async (i: Record<string, unknown>) => {
        sent.push(i);
        return { txHash: ("0x" + "cd".repeat(32)) as Hex, id: "1" };
      },
    } as unknown as Pick<Api, "build" | "submit">;
    const d = { api, chainId: 4663, escrow: getAddress(ESCROW), usdg: USDG, origin: "https://example.test", sign: async (t: never) => user.signTypedData(t) };
    const built = await buildAndVerify(d, { text, sender: user.address });
    expect(built.answer.id).toMatch(/^\d+$/);
    expect(built.answer.feeText).toBeTruthy();
    const out = await signAndSubmit(d, { text, sender: user.address }, built);
    expect(out.claimUrl).toContain("/c/");
    expect(sent[0]).toMatchObject({ from: user.address, validAfter: built.answer.authorization.validAfter });
    expect(String(sent[0]!.signature)).toMatch(/^0x[0-9a-f]{130}$/);
  });

  test("a weekend stock deadline is a question, not a guess", async () => {
    const r = await caller.parse({ text: "/ifso link 20 if nvda at or above 200 by sunday" });
    expect(r.questions.map((q) => q.kind)).toContain("weekend");
  });
});
