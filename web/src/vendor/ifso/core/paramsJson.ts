// JSON (bigints as decimal strings) -> CreateParams. Shared by the API and the web client, so both read a `build` answer the same way.
import type { CreateParams } from "./types";

export function paramsFromJson(j: Record<string, any>): CreateParams {
  const c = j.condition;
  return {
    amount: BigInt(j.amount),
    counterAmount: BigInt(j.counterAmount),
    recipient: j.recipient,
    linkKey: j.linkKey,
    refundTo: j.refundTo,
    altRefundTo: j.altRefundTo,
    expiry: BigInt(j.expiry),
    acceptBy: BigInt(j.acceptBy),
    twoSided: Boolean(j.twoSided),
    cancellable: Boolean(j.cancellable),
    salt: j.salt,
    condition: {
      kind: Number(c.kind),
      mode: Number(c.mode),
      op: Number(c.op),
      source: Number(c.source),
      target: c.target,
      stockToken: c.stockToken,
      key: c.key,
      threshold: BigInt(c.threshold),
      multiplier: BigInt(c.multiplier),
      outcomeMask: BigInt(c.outcomeMask),
      start: BigInt(c.start),
      deadline: BigInt(c.deadline),
      maxStale: Number(c.maxStale),
      holdWindow: Number(c.holdWindow),
    },
  };
}

