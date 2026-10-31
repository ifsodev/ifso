import { describe, expect, test, vi } from "vitest";
import { getAddress, recoverTypedDataAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DecisionAction, decide, redirectRefund } from "@/lib/ifso/decisions";
import { CHAIN_ID, ESCROW } from "./helpers";

const acct = privateKeyToAccount(("0x" + "01".repeat(32)) as `0x${string}`); // test-key
const mk = () => {
  const api = { decide: vi.fn(async () => ({ txHash: "0xabc" as const })), redirectRefund: vi.fn(async () => ({ txHash: "0xdef" as const })) };
  return {
    api,
    deps: {
      api,
      chainId: CHAIN_ID,
      escrow: ESCROW,
      signer: acct.address,
      nonce: vi.fn(async () => 7n),
      sign: (t: never) => acct.signTypedData(t),
      now: () => 1_800_000_000_000,
    },
  };
};

describe("decisions", () => {
  test("OK is signed with the nonce read from the chain and a 10 minute deadline", async () => {
    const { api, deps } = mk();
    expect(await decide(deps as never, "42", DecisionAction.OK)).toBe("0xabc");
    expect(deps.nonce).toHaveBeenCalledWith(acct.address);
    const call = (api.decide.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(call).toMatchObject({ id: "42", signer: acct.address, action: 1, deadline: String(1_800_000_000 + 600) });
    const signer = await recoverTypedDataAddress({
      domain: { name: "IFSO", version: "1", chainId: CHAIN_ID, verifyingContract: ESCROW },
      types: { Decision: [{ name: "id", type: "uint256" }, { name: "action", type: "uint8" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Decision",
      message: { id: 42n, action: 1, nonce: 7n, deadline: BigInt(1_800_000_600) },
      signature: call.signature as `0x${string}`,
    });
    expect(signer).toBe(acct.address);
  });
  test("decline and referee actions map to 2, 3 and 4", async () => {
    const { api, deps } = mk();
    await decide(deps as never, "1", DecisionAction.DECLINE);
    await decide(deps as never, "1", DecisionAction.REFEREE_RELEASE);
    await decide(deps as never, "1", DecisionAction.REFEREE_RETURN);
    expect(api.decide.mock.calls.map((c) => (c as unknown as [{ action: number }])[0].action)).toEqual([2, 3, 4]);
  });
  test("refund redirect signs the new addresses (backup may be the zero address)", async () => {
    const { api, deps } = mk();
    const to = getAddress("0x4444444444444444444444444444444444444444");
    await redirectRefund(deps as never, "9", to, zeroAddress);
    expect((api.redirectRefund.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ id: "9", refundTo: to, altRefundTo: zeroAddress });
  });
});
