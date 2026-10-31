// Audit L-3 regression: `verifyBuildAnswer` only checked that a build answer was internally consistent (nonce, id,
// total). A compromised or buggy server or page could return a self-consistent answer for a DIFFERENT payment (another
// recipient, amount, referee or deadline) and the wallet would sign it. With `asked` the page passes what the user
// asked for and every field is compared. The "asked" checks below FAILED on 6d90e71 (the swapped answers passed).
import { describe, expect, test } from "bun:test";
import { getAddress, type Address, type Hex } from "viem";
import { verifyBuildAnswer, type AskedFor, type BuildAnswer } from "../src/client";
import { buildParams, type BuildInput } from "../src/core/builder";
import { conditionHash, createAuthNonce, escrowId } from "../src/core/condition";
import { createAuthorizationTypedData } from "../src/core/typedData";
import { jsonSafe } from "../src/api/router";

const CHAIN = 4663;
const ESCROW = getAddress("0x00000000000000000000000000000000000e5c20");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const FROM = getAddress("0x00000000000000000000000000000000000000aa");
const BOB = getAddress("0x00000000000000000000000000000000000b0b0b");
const MALLORY = getAddress("0x0000000000000000000000000000000000000bad");
const REF = getAddress("0x0000000000000000000000000000000000000ef0");
const LINK = getAddress("0x000000000000000000000000000000000000c0de");
const AT = Math.floor(Date.now() / 1000) + 7 * 86400;
const FEE = 250_000n;

/** A fully self-consistent answer, as a server that builds the wrong payment correctly would return it. */
function answer(over: Partial<BuildInput> = {}): BuildAnswer {
  const p = buildParams({ draft: { kind: "TIME", at: AT }, nowSec: Math.floor(Date.now() / 1000), amountUsdg: "20", twoSided: false, recipient: BOB, salt: ("0x" + "12".repeat(32)) as Hex, ...over });
  const total = p.amount + FEE;
  const nonce = createAuthNonce(FROM, p);
  const td = createAuthorizationTypedData({ chainId: CHAIN, usdg: USDG, escrow: ESCROW, from: FROM, value: total, validAfter: 0n, validBefore: 9999999999n, nonce });
  return jsonSafe({ id: escrowId(FROM, p.salt), params: p, conditionHash: conditionHash(p.condition), fee: FEE, total, authorization: { validAfter: 0n, validBefore: 9999999999n, nonce, typedData: td } }) as BuildAnswer;
}
const check = (a: BuildAnswer, asked?: AskedFor) => () => verifyBuildAnswer(a, { from: FROM, chainId: CHAIN, escrow: ESCROW, usdg: USDG, asked });

describe("audit L-3: the client checks the build answer against what the user asked for", () => {
  test("the honest answer passes with every field asked", () => {
    expect(check(answer(), { amount: 20_000_000n, recipient: BOB, kind: 1, deadline: AT, twoSided: false, cancellable: false })).not.toThrow();
    expect(check(answer({ recipient: undefined, linkKey: LINK }), { amount: 20_000_000n, linkKey: LINK })).not.toThrow();
  });

  test("another recipient, amount, deadline or kind is refused before anything is signed", () => {
    const asked: AskedFor = { amount: 20_000_000n, recipient: BOB, kind: 1, deadline: AT };
    for (const swapped of [answer({ recipient: MALLORY }), answer({ amountUsdg: "2000" }), answer({ draft: { kind: "TIME", at: AT + 86400 } }), answer({ recipient: undefined, linkKey: LINK })]) {
      expect(check(swapped)).not.toThrow(); // internally consistent: the old check alone lets it through
      expect(check(swapped, asked)).toThrow(/nothing was signed/);
    }
  });

  test("a claim link answer bound to another link key is refused", () => {
    expect(check(answer({ recipient: undefined, linkKey: MALLORY }), { linkKey: LINK })).toThrow("not your claim link");
  });

  test("a referee payment decided by another referee is refused", () => {
    const ref = (r: Address) => answer({ draft: { kind: "APPROVE", mode: "REFEREE", referee: { type: "address", address: r } } as never, referee: r });
    expect(check(ref(REF), { referee: REF, kind: 3 })).not.toThrow();
    expect(check(ref(MALLORY), { referee: REF, kind: 3 })).toThrow("not the referee you asked for");
  });
});
