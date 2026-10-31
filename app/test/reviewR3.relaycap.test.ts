// Security review round 3 (FINAL), R3-M1 regression (PoC from docs/reviews/pocs-r3, FAILED on c5bf754): the sender
// burned the shared per-escrow relay cap with VALID refund-address toggles, so the referee's gasless decision was
// refused for the day. Fix: the cap is keyed on escrow AND signer, and terminal decisions are never capped.
import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter } from "../src/api/router";
import { loadEnv } from "../src/config/env";
import { decisionTypes, ifsoDomain, refundRedirectTypes } from "../src/core/typedData";
import { Status } from "../src/core/types";
import type { Deps } from "../src/workers/deps";

const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SENDER_ACC = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex); // test-key
const RECIPIENT_ACC = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex); // test-key
const REFEREE_ACC = privateKeyToAccount(("0x" + "33".repeat(32)) as Hex); // test-key
const ALT = "0x000000000000000000000000000000000000a17e" as Address;

function stub() {
  const sent: Array<{ functionName: string; args: readonly unknown[] }> = [];
  // a live referee escrow; a relayed setRefundAddressesBySig really changes refundTo (the stub mirrors the contract)
  const e: Record<string, unknown> = { sender: SENDER_ACC.address, recipient: RECIPIENT_ACC.address, refundTo: SENDER_ACC.address, altRefundTo: ZERO, flags: 0, status: Status.OPEN, expiry: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400), amount: 20_000_000n };
  const wallet = {
    account: { address: "0x00000000000000000000000000000000000000ee" },
    writeContract: async (req: { functionName: string; args: readonly unknown[] }) => {
      sent.push(req);
      if (req.functionName === "setRefundAddressesBySig") { e.refundTo = req.args[1]; e.altRefundTo = req.args[2]; }
      return "0xabc" as Hex;
    },
  };
  const deps = {
    env: loadEnv({ ESCROW_ADDRESS: ESCROW }), // shipped defaults: RELAY_PER_ESCROW_PER_DAY=10, RELAY_PER_SIGNER_PER_HOUR=20
    log: () => {},
    db: { insert: () => ({ values: async () => {} }) },
    clients: {
      chain: { id: 4663 }, escrow: ESCROW, relayer: wallet,
      publicClient: {
        readContract: async ({ functionName }: { functionName: string }) => (functionName === "getEscrow" ? e : functionName === "nonces" ? 0n : { kind: 1 }),
        simulateContract: async (req: { functionName: string; args: readonly unknown[] }) => {
          // only the referee may decide (the contract's rule); every redirect by the sender is valid
          if (req.functionName === "decideBySig" && String(req.args[1]).toLowerCase() !== REFEREE_ACC.address.toLowerCase()) throw new Error("NotAuthorized()");
          return { request: req };
        },
        estimateContractGas: async () => 100_000n, getGasPrice: async () => 1_000_000n,
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
    },
  } as unknown as Deps;
  return { deps, sent, e };
}
const caller = (deps: Deps, ip: string, limiter: RateLimiter) => appRouter.createCaller({ deps, limiter, ip, country: "DE" });
const red = async (deps: Deps, ip: string, l: RateLimiter, refundTo: Address) =>
  caller(deps, ip, l).redirectRefund({ id: "9", refundTo, altRefundTo: ZERO, deadline: "9999999999", signature: await SENDER_ACC.signTypedData({ domain: ifsoDomain(4663, ESCROW), types: refundRedirectTypes, primaryType: "RefundRedirect", message: { id: 9n, refundTo, altRefundTo: ZERO, nonce: 0n, deadline: 9999999999n } }) });

describe("R3-M1: the sender's valid refund toggles lock the referee out of the gasless decision", () => {
  test("after 10 real A->B->A redirects by the sender, the referee's release still relays", async () => {
    const { deps, sent } = stub();
    const l = new RateLimiter();
    for (let i = 0; i < 10; i++) await red(deps, `198.51.100.${i}`, l, i % 2 === 0 ? ALT : SENDER_ACC.address);
    expect(sent.filter((s) => s.functionName === "setRefundAddressesBySig").length).toBe(10); // every toggle was real and relayed
    const sig = await REFEREE_ACC.signTypedData({ domain: ifsoDomain(4663, ESCROW), types: decisionTypes, primaryType: "Decision", message: { id: 9n, action: 3, nonce: 0n, deadline: 9999999999n } });
    let refused: string | undefined;
    await caller(deps, "203.0.113.9", l).decide({ id: "9", signer: REFEREE_ACC.address, action: 3, deadline: "9999999999", signature: sig }).catch((err: Error) => (refused = err.message));
    expect(refused).toBeUndefined(); // c5bf754: "too many changes to this payment today, try again tomorrow"
    expect(sent.at(-1)?.functionName).toBe("decideBySig");
  });

  test("the sender and a third wallet each still hit their own per-escrow cap", async () => {
    const { deps, sent } = stub();
    const l = new RateLimiter();
    for (let i = 0; i < 10; i++) await red(deps, `198.51.100.${i}`, l, i % 2 === 0 ? ALT : SENDER_ACC.address);
    await expect(red(deps, "198.51.100.77", l, ALT)).rejects.toThrow("too many changes to this payment today");
    expect(sent.filter((s) => s.functionName === "setRefundAddressesBySig").length).toBe(10);
    // the recipient's OK (non-terminal) is charged to the recipient only, and still goes through
    const ok = await RECIPIENT_ACC.signTypedData({ domain: ifsoDomain(4663, ESCROW), types: decisionTypes, primaryType: "Decision", message: { id: 9n, action: 1, nonce: 0n, deadline: 9999999999n } });
    await caller(deps, "203.0.113.10", l).decide({ id: "9", signer: RECIPIENT_ACC.address, action: 1, deadline: "9999999999", signature: ok }).catch(() => undefined);
    const okLimited = await l.hit(`relay:escrow:9:${RECIPIENT_ACC.address.toLowerCase()}`, 10, 86400);
    expect(okLimited).toBe(true); // its own counter, far from the cap
  });
});
