// The site reads payment ids through the vendored shared parser (app/src/core/paymentId.ts): real escrow ids are
// uint256 keccak hashes, 76 to 78 digits.
import { describe, expect, test } from "vitest";
import { MAX_PAYMENT_ID, parsePaymentId, paymentIdString } from "@/vendor/ifso/client";

const ID_78 = "115792089237316195423570985008687907853269984665640564039457584007913129639935"; // type(uint256).max
const TESTNET_ID_78 = "100445847310731864578693424659970785724122250073438508132425330087614763585464"; // chain 46630
const TESTNET_ID_77 = "51376264011080535736083553933417392956537887801181481883072869833438858223172"; // chain 46630

describe("payment ids on the site", () => {
  test("real ids parse to the exact uint256", () => {
    expect(MAX_PAYMENT_ID.toString()).toBe(ID_78);
    for (const id of [ID_78, TESTNET_ID_78, TESTNET_ID_77]) expect(parsePaymentId(` ${id} `)).toBe(BigInt(id));
  });
  test("out of range, zero and non-digits are refused", () => {
    for (const bad of ["0", (MAX_PAYMENT_ID + 1n).toString(), "9".repeat(79), "1.5", "abc", ""]) expect(paymentIdString(bad)).toBeUndefined();
  });
});
