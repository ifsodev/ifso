// Audit M-1 regression (PoC from the audit-grade report, inverted): anyone could replay a victim's ALREADY-USED gasless
// create / accept authorization (public calldata). The per-signer relay budget was charged before the simulation
// failed, so 20 replays locked the victim's own gasless decide for the hour. Now the call is simulated first and only
// a call that would go through is charged: after 20 replays the victim's decide still relays.
import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter, jsonSafe } from "../src/api/router";
import { loadEnv } from "../src/config/env";
import { createAuthNonce, acceptAuthNonce } from "../src/core/condition";
import { createAuthorizationTypedData, decisionTypes, ifsoDomain } from "../src/core/typedData";
import { emptyCondition, Kind, Status, type CreateParams } from "../src/core/types";
import type { Deps } from "../src/workers/deps";

const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const VICTIM = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex); // test-key
const OTHER = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex); // test-key
const FEE = 100_000n;

function stub() {
  const sent: string[] = [];
  const e: Record<string, unknown> = { sender: VICTIM.address, recipient: OTHER.address, refundTo: VICTIM.address, altRefundTo: ZERO, flags: 1, status: Status.OPEN, expiry: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400), amount: 20_000_000n, counterAmount: 20_000_000n, linkKey: ZERO, conditionHash: ("0x" + "00".repeat(32)) as Hex };
  const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" }, writeContract: async (r: { functionName: string }) => (sent.push(r.functionName), "0xabc" as Hex) };
  const deps = {
    env: loadEnv({ ESCROW_ADDRESS: ESCROW }),
    log: () => {},
    db: { insert: () => ({ values: async () => {} }), update: () => ({ set: () => ({ where: async () => {} }) }) },
    clients: {
      chain: { id: 4663 }, escrow: ESCROW, relayer: wallet, usdg: USDG,
      publicClient: {
        readContract: async ({ functionName }: { functionName: string }) => (functionName === "getEscrow" ? e : functionName === "nonces" ? 0n : functionName === "feeFor" ? FEE : { kind: 1 }),
        simulateContract: async (req: { functionName: string }) => {
          // the authorization was already used on chain: the contract / USDG reverts
          if (req.functionName === "createWithAuthorization" || req.functionName === "acceptWithAuthorization") throw new Error("AuthorizationUsedOrCanceled");
          return { request: req };
        },
        estimateContractGas: async () => 100_000n, getGasPrice: async () => 1n,
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
    },
  } as unknown as Deps;
  return { deps, sent };
}

const params = (): CreateParams => {
  const c = emptyCondition(); c.kind = Kind.APPROVE; c.mode = 0;
  return { amount: 5_000_000n, counterAmount: 0n, recipient: OTHER.address, linkKey: ZERO, refundTo: ZERO, altRefundTo: ZERO, expiry: 9999999999n, acceptBy: 0n, twoSided: false, cancellable: false, salt: ("0x" + "ab".repeat(32)) as Hex, condition: c };
};

describe("audit M-1: replaying a used authorization never burns the signer's relay budget", () => {
  test("create replay: 20 junk submits by an attacker leave the victim's gasless decide working", async () => {
    const { deps, sent } = stub();
    const l = new RateLimiter();
    const p = params();
    // what the victim signed once (visible later in the createWithAuthorization calldata on chain)
    const td = createAuthorizationTypedData({ chainId: 4663, usdg: USDG, escrow: ESCROW, from: VICTIM.address, value: p.amount + FEE, validAfter: 0n, validBefore: 9999999999n, nonce: createAuthNonce(VICTIM.address, p) });
    const sig = await VICTIM.signTypedData(td);
    const attacker = appRouter.createCaller({ deps, limiter: l, ip: "198.51.100.66", country: "DE" }); // ONE attacker IP
    let refusedSubmits = 0;
    for (let i = 0; i < 20; i++) await attacker.submit({ params: jsonSafe(p) as Record<string, unknown>, from: VICTIM.address, validAfter: "0", validBefore: "9999999999", signature: sig }).catch(() => refusedSubmits++);
    expect(refusedSubmits).toBe(20); // every replay failed (simulation), nothing was sent...
    expect(sent.length).toBe(0);
    // ...and none was charged to the VICTIM's wallet budget. The victim's own decision still relays:
    const dsig = await VICTIM.signTypedData({ domain: ifsoDomain(4663, ESCROW), types: decisionTypes, primaryType: "Decision", message: { id: 9n, action: 2, nonce: 0n, deadline: 9999999999n } });
    const r = await appRouter.createCaller({ deps, limiter: l, ip: "203.0.113.5", country: "DE" }).decide({ id: "9", signer: VICTIM.address, action: 2, deadline: "9999999999", signature: dsig });
    expect(r.txHash).toBe("0xabc");
    expect(sent).toEqual(["decideBySig"]);
  });

  test("accept replay: 20 junk accepts leave the acceptor's gasless decide working", async () => {
    const { deps, sent } = stub();
    const l = new RateLimiter();
    const td = createAuthorizationTypedData({ chainId: 4663, usdg: USDG, escrow: ESCROW, from: VICTIM.address, value: 20_000_000n, validAfter: 0n, validBefore: 9999999999n, nonce: acceptAuthNonce(9n, VICTIM.address, VICTIM.address) });
    const authSig = await VICTIM.signTypedData(td);
    const attacker = appRouter.createCaller({ deps, limiter: l, ip: "198.51.100.67", country: "DE" });
    for (let i = 0; i < 20; i++) await attacker.accept({ id: "9", acceptor: VICTIM.address, linkSig: "0x", counterRefundTo: VICTIM.address, validAfter: "0", validBefore: "9999999999", authSig }).catch(() => {});
    const dsig = await VICTIM.signTypedData({ domain: ifsoDomain(4663, ESCROW), types: decisionTypes, primaryType: "Decision", message: { id: 9n, action: 2, nonce: 0n, deadline: 9999999999n } });
    const r = await appRouter.createCaller({ deps, limiter: l, ip: "203.0.113.6", country: "DE" }).decide({ id: "9", signer: VICTIM.address, action: 2, deadline: "9999999999", signature: dsig });
    expect(r.txHash).toBe("0xabc");
    expect(sent).toEqual(["decideBySig"]);
  });

  test("an expired authorization is refused before any chain call or budget charge", async () => {
    const { deps, sent } = stub();
    const l = new RateLimiter();
    const p = params();
    const td = createAuthorizationTypedData({ chainId: 4663, usdg: USDG, escrow: ESCROW, from: VICTIM.address, value: p.amount + FEE, validAfter: 0n, validBefore: 1000n, nonce: createAuthNonce(VICTIM.address, p) });
    const sig = await VICTIM.signTypedData(td);
    let err: string | undefined;
    await appRouter.createCaller({ deps, limiter: l, ip: "198.51.100.68", country: "DE" }).submit({ params: jsonSafe(p) as Record<string, unknown>, from: VICTIM.address, validAfter: "0", validBefore: "1000", signature: sig }).catch((x: Error) => (err = x.message));
    expect(err).toBe("this payment authorization has expired");
    expect(sent.length).toBe(0);
  });

  test("control: without the replays the victim's decide relays", async () => {
    const { deps, sent } = stub();
    const l = new RateLimiter();
    const dsig = await VICTIM.signTypedData({ domain: ifsoDomain(4663, ESCROW), types: decisionTypes, primaryType: "Decision", message: { id: 9n, action: 2, nonce: 0n, deadline: 9999999999n } });
    const r = await appRouter.createCaller({ deps, limiter: l, ip: "203.0.113.7", country: "DE" }).decide({ id: "9", signer: VICTIM.address, action: 2, deadline: "9999999999", signature: dsig });
    expect(r.txHash).toBe("0xabc");
    expect(sent).toEqual(["decideBySig"]);
  });
});
