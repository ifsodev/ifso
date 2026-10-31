import type { Address, Hex } from "viem";
import { decisionTypedData, refundRedirectTypedData, DecisionAction } from "@/vendor/ifso/client";
import type { Api } from "./api";

export { DecisionAction };

type SignTyped = (t: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }) => Promise<Hex>;

export interface RelayDeps {
  api: Pick<Api, "decide" | "redirectRefund">;
  chainId: number;
  escrow: Address;
  signer: Address;
  sign: SignTyped;
  /** reads escrow.nonces(owner) */
  nonce: (owner: Address) => Promise<bigint>;
  now?: () => number;
}

const deadlineIn = (now: number, secs: number) => BigInt(Math.floor(now / 1000) + secs);

/** OK / decline / referee release / referee return. Nonce is read right before signing; the relayer pays gas. */
export async function decide(d: RelayDeps, id: string, action: number): Promise<Hex> {
  const nonce = await d.nonce(d.signer);
  const deadline = deadlineIn((d.now ?? Date.now)(), 600);
  const typed = decisionTypedData({ chainId: d.chainId, escrow: d.escrow, id: BigInt(id), action, nonce, deadline });
  const signature = await d.sign(typed as never);
  return (await d.api.decide({ id, signer: d.signer, action, deadline: deadline.toString(), signature })).txHash;
}

/** The sender changes where a refund goes. `altRefundTo` may be the zero address. */
export async function redirectRefund(d: RelayDeps, id: string, refundTo: Address, altRefundTo: Address): Promise<Hex> {
  const nonce = await d.nonce(d.signer);
  const deadline = deadlineIn((d.now ?? Date.now)(), 600);
  const typed = refundRedirectTypedData({ chainId: d.chainId, escrow: d.escrow, id: BigInt(id), refundTo, altRefundTo, nonce, deadline });
  const signature = await d.sign(typed as never);
  return (await d.api.redirectRefund({ id, refundTo, altRefundTo, deadline: deadline.toString(), signature })).txHash;
}
