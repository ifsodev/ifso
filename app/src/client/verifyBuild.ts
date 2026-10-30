// Defence in depth for the create flow: before the wallet signs what `build` returned, check it says what the user
// asked for. The server already builds it correctly; this makes a tampered or misrouted answer fail loudly.
import { getAddress, type Address, type Hex } from "viem";
import { conditionHash, createAuthNonce, escrowId } from "../core/condition";
import { paramsFromJson } from "../core/paramsJson";

export interface BuildAnswer {
  id: string;
  params: Record<string, any>;
  conditionHash: Hex;
  fee: string;
  total: string;
  authorization: { validAfter: string; validBefore: string; nonce: Hex; typedData: { domain: any; message: Record<string, any>; primaryType: string } };
}

/**
 * Throws if the typed data is not a USDG transfer of exactly `total` from `from` to the escrow, bound to these exact
 * params (nonce), with the id and condition hash the params imply. Call it between `build` and `signTypedData`.
 * @example verifyBuildAnswer(answer, { from: account, chainId: 4663, escrow: ESCROW, usdg: USDG })
 */
export function verifyBuildAnswer(a: BuildAnswer, expect: { from: Address; chainId: number; escrow: Address; usdg: Address }): void {
  const p = paramsFromJson(a.params);
  const m = a.authorization.typedData.message;
  const d = a.authorization.typedData.domain;
  const bad = (why: string) => {
    throw new Error(`the payment details do not check out (${why}); nothing was signed`);
  };
  if (a.authorization.typedData.primaryType !== "ReceiveWithAuthorization") bad("wrong message type");
  if (Number(d.chainId) !== expect.chainId) bad("wrong network");
  if (getAddress(d.verifyingContract) !== getAddress(expect.usdg)) bad("wrong token");
  if (getAddress(m.from) !== getAddress(expect.from)) bad("wrong sender");
  if (getAddress(m.to) !== getAddress(expect.escrow)) bad("wrong destination");
  if (BigInt(m.value) !== BigInt(a.total) || BigInt(a.total) !== p.amount + BigInt(a.fee)) bad("wrong amount");
  if (String(m.nonce).toLowerCase() !== createAuthNonce(expect.from, p).toLowerCase()) bad("not bound to these details");
  if (BigInt(a.id) !== escrowId(expect.from, p.salt)) bad("wrong payment id");
  if (a.conditionHash.toLowerCase() !== conditionHash(p.condition).toLowerCase()) bad("wrong condition");
}
