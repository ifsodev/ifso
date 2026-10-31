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
 * What the user asked for, as the page knows it (audit L-3). Every field given is compared with the params `build`
 * returned; a field left out is not checked. Amounts are USDG base units (6 decimals); `deadline` is unix seconds;
 * `threshold` is in the condition's own units (8-decimal feed units for a price). `referee` is the address that decides
 * a referee payment (the condition's target).
 */
export interface AskedFor {
  amount?: bigint;
  counterAmount?: bigint;
  /** A named recipient. Asking for one also requires that no claim link key is set. */
  recipient?: Address;
  /** The claim link's derived address. Asking for one also requires that no recipient is named. */
  linkKey?: Address;
  referee?: Address;
  kind?: number;
  threshold?: bigint;
  deadline?: bigint | number;
  twoSided?: boolean;
  cancellable?: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Throws if the typed data is not a USDG transfer of exactly `total` from `from` to the escrow, bound to these exact
 * params (nonce), with the id and condition hash the params imply, and (audit L-3) if the params differ from any field
 * of `asked`: a buggy or compromised server or page cannot get a different payment signed than the one the user asked
 * for. Call it between `build` and `signTypedData`.
 * @example verifyBuildAnswer(answer, { from: account, chainId: 4663, escrow: ESCROW, usdg: USDG, asked: { amount: 20_000_000n, linkKey } })
 */
export function verifyBuildAnswer(a: BuildAnswer, expect: { from: Address; chainId: number; escrow: Address; usdg: Address; asked?: AskedFor }): void {
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

  const q = expect.asked;
  if (!q) return;
  const sameAddr = (x: string, y: string) => getAddress(x) === getAddress(y);
  if (q.amount !== undefined && p.amount !== BigInt(q.amount)) bad("not the amount you asked for");
  if (q.counterAmount !== undefined && p.counterAmount !== BigInt(q.counterAmount)) bad("not the amount you asked for");
  if (q.recipient !== undefined && (!sameAddr(p.recipient, q.recipient) || !sameAddr(p.linkKey, ZERO))) bad("not the recipient you asked for");
  if (q.linkKey !== undefined && (!sameAddr(p.linkKey, q.linkKey) || !sameAddr(p.recipient, ZERO))) bad("not your claim link");
  if (q.kind !== undefined && Number(p.condition.kind) !== Number(q.kind)) bad("not the condition you asked for");
  if (q.referee !== undefined && !sameAddr(p.condition.target, q.referee)) bad("not the referee you asked for");
  if (q.threshold !== undefined && p.condition.threshold !== BigInt(q.threshold)) bad("not the condition you asked for");
  if (q.deadline !== undefined && p.condition.deadline !== BigInt(q.deadline)) bad("not the deadline you asked for");
  if (q.twoSided !== undefined && p.twoSided !== q.twoSided) bad("not the kind of payment you asked for");
  if (q.cancellable !== undefined && p.cancellable !== q.cancellable) bad("not the kind of payment you asked for");
}
