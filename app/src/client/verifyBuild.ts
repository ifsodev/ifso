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
 * What the user asked for, as the page knows it (audit L-3, L-10). Every field given is compared with the params `build`
 * returned; a field left out is not checked, except the refund destinations (see `refundTo`). Amounts are USDG base
 * units (6 decimals); `deadline`, `expiry` and `acceptBy` are unix seconds; `threshold` is in the condition's own units
 * (8-decimal feed units for a price). `referee` is the address that decides a referee payment (the condition's target).
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
  /** Price direction: 0 = at or above (GTE), 1 = at or below (LTE). */
  op?: number;
  /** The condition's mode (for a price: at the deadline, or touch before it). */
  mode?: number;
  threshold?: bigint;
  deadline?: bigint | number;
  /** When the payment can be refunded (unix seconds). */
  expiry?: bigint | number;
  /** A challenge's last accept time (unix seconds; 0 for a one-sided payment). */
  acceptBy?: bigint | number;
  /** The price feed a price condition reads (the condition's target). */
  feed?: Address;
  /** The Stock Token of a stock price condition (0 for a crypto price). */
  stockToken?: Address;
  /** The resolver question id of an outcome condition (the condition's key). */
  outcomeKey?: Hex;
  outcomeMask?: bigint;
  /**
   * Where the money comes back to. Left out, the answer must name 0 (the contract then uses the sender) or the sender
   * itself: a refund to anyone else is refused unless the caller asks for that address here.
   */
  refundTo?: Address;
  /** The alternate refund address. Left out, it must be 0 (none) or the sender, as for `refundTo`. */
  altRefundTo?: Address;
  twoSided?: boolean;
  cancellable?: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Throws if the typed data is not a USDG transfer of exactly `total` from `from` to the escrow, bound to these exact
 * params (nonce), with the id and condition hash the params imply, if (audit L-3, L-10) the params differ from any field
 * of `asked`, and if a refund would go anywhere but the sender (0 or `from`) without `asked` naming that address: a buggy
 * or compromised server cannot get a payment signed that differs from what the caller asked for in any field it gave.
 * Fields the caller leaves out of `asked` are not compared, so pass every field the page knows. Call it between `build`
 * and `signTypedData`.
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

  const q = expect.asked ?? {};
  const sameAddr = (x: string, y: string) => getAddress(x) === getAddress(y);
  // audit L-10: the refund destinations are always checked, so a tampered answer cannot send a refund elsewhere
  const ownRefund = (x: string) => sameAddr(x, ZERO) || sameAddr(x, expect.from);
  if (q.refundTo !== undefined ? !sameAddr(p.refundTo, q.refundTo) : !ownRefund(p.refundTo)) bad("the money would not come back to you");
  if (q.altRefundTo !== undefined ? !sameAddr(p.altRefundTo, q.altRefundTo) : !ownRefund(p.altRefundTo)) bad("the money would not come back to you");
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
  if (q.op !== undefined && Number(p.condition.op) !== Number(q.op)) bad("not the condition you asked for");
  if (q.mode !== undefined && Number(p.condition.mode) !== Number(q.mode)) bad("not the condition you asked for");
  if (q.feed !== undefined && !sameAddr(p.condition.target, q.feed)) bad("not the condition you asked for");
  if (q.stockToken !== undefined && !sameAddr(p.condition.stockToken, q.stockToken)) bad("not the condition you asked for");
  if (q.outcomeKey !== undefined && p.condition.key.toLowerCase() !== q.outcomeKey.toLowerCase()) bad("not the condition you asked for");
  if (q.outcomeMask !== undefined && p.condition.outcomeMask !== BigInt(q.outcomeMask)) bad("not the condition you asked for");
  if (q.expiry !== undefined && p.expiry !== BigInt(q.expiry)) bad("not the refund time you asked for");
  if (q.acceptBy !== undefined && p.acceptBy !== BigInt(q.acceptBy)) bad("not the accept time you asked for");
}
