// Audit L-10 regression (residual of audit L-3; PoC of 4318745): verifyBuildAnswer promised that "a buggy or compromised
// server or page cannot get a different payment signed than the one the user asked for", but it never checked refundTo /
// altRefundTo, the price direction (op) or mode, expiry, acceptBy, stockToken, or (OUTCOME) the question key / mask. A
// server returning internally consistent params with refundTo = attacker (or op flipped) passed every check. Now every
// AskedFor field is compared and a refund to anyone but the sender is refused unless asked for. Pure unit test.
import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { buildParams } from "../src/core/builder";
import { conditionHash, createAuthNonce, escrowId } from "../src/core/condition";
import { createAuthorizationTypedData } from "../src/core/typedData";
import { OP_LTE } from "../src/core/types";
import { verifyBuildAnswer } from "../src/client/verifyBuild";
import { jsonSafe } from "../src/api/router";
import type { CreateParams } from "../src/core/types";

const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const FROM = "0x1111111111111111111111111111111111111111" as Address;
const RECIPIENT = "0x00000000000000000000000000000000000b0b0b" as Address;
const ATTACKER = "0x000000000000000000000000000000000000dEaD" as Address;
const FEED = "0x2222222222222222222222222222222222222222" as Address;
const FEE = 250_000n;
const now = Math.floor(Date.now() / 1000);

/** What a (malicious) server returns: every hash and the typed data recomputed so the answer is self-consistent. */
function answer(p: CreateParams) {
  const value = p.amount + FEE;
  const nonce = createAuthNonce(FROM, p);
  const td = createAuthorizationTypedData({ chainId: 4663, usdg: USDG, escrow: ESCROW, from: FROM, value, validAfter: 0n, validBefore: 9999999999n, nonce });
  return jsonSafe({ id: escrowId(FROM, p.salt), params: p, conditionHash: conditionHash(p.condition), fee: FEE, total: value, authorization: { validAfter: 0n, validBefore: 9999999999n, nonce, typedData: td } }) as any;
}
const price = () =>
  buildParams({ draft: { kind: "PRICE", ticker: "ETH", op: "GTE", priceUsd: "5000", mode: "AT_DEADLINE", deadline: now + 7 * 86400 } as any, nowSec: now, amountUsdg: "100", twoSided: false, recipient: RECIPIENT, feed: { feed: FEED, multiplier: 0n } });
const asked = (p: CreateParams) => ({ amount: p.amount, recipient: RECIPIENT, kind: p.condition.kind, op: p.condition.op, mode: p.condition.mode, feed: p.condition.target, stockToken: p.condition.stockToken, threshold: p.condition.threshold, deadline: p.condition.deadline, expiry: p.expiry, acceptBy: p.acceptBy, cancellable: false, twoSided: false });
const expect0 = { from: FROM, chainId: 4663, escrow: ESCROW, usdg: USDG };

describe("L-10: verifyBuildAnswer compares every asked field", () => {
  test("control: the honest answer passes; a changed amount or recipient is caught", () => {
    const p = price();
    const a = asked(p);
    expect(() => verifyBuildAnswer(answer(p), { ...expect0, asked: a })).not.toThrow();
    expect(() => verifyBuildAnswer(answer(p), expect0)).not.toThrow(); // no asked fields: the default refund check only
    expect(() => verifyBuildAnswer(answer({ ...p, amount: p.amount + 1n }), { ...expect0, asked: a })).toThrow("not the amount");
    expect(() => verifyBuildAnswer(answer({ ...p, recipient: ATTACKER }), { ...expect0, asked: a })).toThrow("not the recipient");
  });

  test("refundTo or altRefundTo = attacker is refused, even when the caller asked for nothing", () => {
    const p = price();
    for (const q of [asked(p), undefined]) {
      expect(() => verifyBuildAnswer(answer({ ...p, refundTo: ATTACKER }), { ...expect0, asked: q })).toThrow("would not come back to you");
      expect(() => verifyBuildAnswer(answer({ ...p, altRefundTo: ATTACKER }), { ...expect0, asked: q })).toThrow("would not come back to you");
    }
    expect(() => verifyBuildAnswer(answer({ ...p, refundTo: FROM, altRefundTo: FROM }), { ...expect0, asked: asked(p) })).not.toThrow();
    // a refund address the caller asked for on purpose
    expect(() => verifyBuildAnswer(answer({ ...p, altRefundTo: ATTACKER }), { ...expect0, asked: { ...asked(p), altRefundTo: ATTACKER } })).not.toThrow();
    expect(() => verifyBuildAnswer(answer(p), { ...expect0, asked: { refundTo: ATTACKER } })).toThrow("would not come back to you");
  });

  test("'ETH at or above 5000' flipped to 'at or below 5000', or another mode, is refused", () => {
    const p = price();
    expect(() => verifyBuildAnswer(answer({ ...p, condition: { ...p.condition, op: OP_LTE } }), { ...expect0, asked: asked(p) })).toThrow("not the condition");
    expect(() => verifyBuildAnswer(answer({ ...p, condition: { ...p.condition, mode: p.condition.mode + 1 } }), { ...expect0, asked: asked(p) })).toThrow("not the condition");
    expect(() => verifyBuildAnswer(answer({ ...p, condition: { ...p.condition, target: ATTACKER } }), { ...expect0, asked: asked(p) })).toThrow("not the condition");
    expect(() => verifyBuildAnswer(answer({ ...p, condition: { ...p.condition, stockToken: ATTACKER } }), { ...expect0, asked: asked(p) })).toThrow("not the condition");
  });

  test("an expiry years away (refund locked) or another acceptBy is refused", () => {
    const p = price();
    expect(() => verifyBuildAnswer(answer({ ...p, expiry: p.expiry + 10n * 365n * 86400n }), { ...expect0, asked: asked(p) })).toThrow("not the refund time");
    expect(() => verifyBuildAnswer(answer({ ...p, acceptBy: p.acceptBy + 1n }), { ...expect0, asked: asked(p) })).toThrow("not the accept time");
  });

  test("an outcome question key or mask other than asked is refused", () => {
    const p = price();
    const key = `0x${"ab".repeat(32)}` as const;
    const o = { ...p, condition: { ...p.condition, key, outcomeMask: 2n } };
    expect(() => verifyBuildAnswer(answer(o), { ...expect0, asked: { outcomeKey: key, outcomeMask: 2n } })).not.toThrow();
    expect(() => verifyBuildAnswer(answer({ ...o, condition: { ...o.condition, key: `0x${"cd".repeat(32)}` } }), { ...expect0, asked: { outcomeKey: key } })).toThrow("not the condition");
    expect(() => verifyBuildAnswer(answer({ ...o, condition: { ...o.condition, outcomeMask: 1n } }), { ...expect0, asked: { outcomeMask: 2n } })).toThrow("not the condition");
  });
});
