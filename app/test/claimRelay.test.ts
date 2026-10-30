// Exercises the server-side link/claim relay (src/api/claim.ts) with stubbed chain + DB clients.
import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { ClaimError, relayClaim } from "../src/api/claim";
import { RateLimiter } from "../src/api/rateLimit";
import { loadEnv } from "../src/config/env";
import { linkKeyAddress, signClaim } from "../src/core/link";
import { Status } from "../src/core/types";
import type { Deps } from "../src/workers/deps";

const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const secret = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const recipient = "0x0000000000000000000000000000000000000b0b" as Address;
const CH = ("0x" + "42".repeat(32)) as Hex;
const ZERO = "0x0000000000000000000000000000000000000000";

function stubDeps(escrowOverrides: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const sent: unknown[] = [];
  const e = { linkKey: linkKeyAddress(secret), flags: 0, status: Status.OPEN, recipient: ZERO, expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), amount: 20_000_000n, conditionHash: CH, ...escrowOverrides };
  const deps = {
    env: loadEnv({ ESCROW_ADDRESS: ESCROW, ...env }),
    log: () => {},
    db: { insert: () => ({ values: async () => {} }) },
    clients: {
      chain: { id: 4663 },
      escrow: ESCROW,
      relayer: { account: { address: "0x00000000000000000000000000000000000000ee" }, writeContract: async (req: unknown) => (sent.push(req), "0xabc" as Hex) },
      publicClient: {
        readContract: async ({ functionName }: { functionName: string }) => (functionName === "getEscrow" ? e : { kind: 1 }),
        simulateContract: async (req: unknown) => ({ request: req }),
        estimateContractGas: async () => 100_000n,
        getGasPrice: async () => 1_000_000n,
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
    },
  } as unknown as Deps;
  return { deps, sent };
}

const sig = (to: Address = recipient) => signClaim({ secret, chainId: 4663, escrow: ESCROW, id: 9n, recipient: to, conditionHash: CH });

describe("relayClaim", () => {
  test("happy path: relays claim(id, recipient, sig)", async () => {
    const { deps, sent } = stubDeps();
    const r = await relayClaim(deps, new RateLimiter(), { id: 9n, recipient, signature: await sig(), ip: "1.2.3.4" });
    expect(r).toEqual({ txHash: "0xabc", status: "bound" });
    expect((sent[0] as { functionName: string; args: unknown[] }).functionName).toBe("claim");
    expect((sent[0] as { args: unknown[] }).args[0]).toBe(9n);
  });

  test("MET escrow reports immediate payment", async () => {
    const { deps } = stubDeps({ status: Status.MET });
    expect((await relayClaim(deps, new RateLimiter(), { id: 9n, recipient, signature: await sig(), ip: "1.2.3.5" })).status).toBe("paid");
  });

  test("signature for another recipient is rejected before any gas is spent", async () => {
    const { deps, sent } = stubDeps();
    const other = await sig("0x0000000000000000000000000000000000000bad");
    await expect(relayClaim(deps, new RateLimiter(), { id: 9n, recipient, signature: other, ip: "1.2.3.6" })).rejects.toBeInstanceOf(ClaimError);
    expect(sent.length).toBe(0);
  });

  test("not claimable: already bound, expired, challenge, not a link, dust", async () => {
    const cases: Record<string, unknown>[] = [
      { recipient: "0x0000000000000000000000000000000000000001" },
      { expiry: 1n },
      { flags: 1 },
      { linkKey: ZERO },
      { amount: 999_999n },
      { status: Status.RELEASED },
    ];
    for (const c of cases) {
      const { deps, sent } = stubDeps(c);
      await expect(relayClaim(deps, new RateLimiter(), { id: 9n, recipient, signature: await sig(), ip: "1.2.3.7" })).rejects.toBeInstanceOf(ClaimError);
      expect(sent.length).toBe(0);
    }
  });

  test("per-IP rate limit", async () => {
    const { deps } = stubDeps({}, { CLAIM_RELAY_PER_IP_PER_HOUR: "2" });
    const lim = new RateLimiter();
    const s = await sig();
    await relayClaim(deps, lim, { id: 9n, recipient, signature: s, ip: "9.9.9.9" });
    await relayClaim(deps, lim, { id: 9n, recipient, signature: s, ip: "9.9.9.9" });
    await expect(relayClaim(deps, lim, { id: 9n, recipient, signature: s, ip: "9.9.9.9" })).rejects.toThrow("too many claims");
  });
});
