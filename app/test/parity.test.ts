// Cross-language vectors: the same constants are asserted on-chain by contracts/test/Vectors.t.sol.
import { describe, expect, test } from "bun:test";
import { hashStruct } from "viem";
import { acceptAuthNonce, conditionHash, createAuthNonce, CREATE_AUTH_TAG, escrowId } from "../src/core/condition";
import { claimTypes, decisionTypes } from "../src/core/typedData";
import { V_ACCEPTOR, V_CONDITION, V_PARAMS, V_SALT, V_SENDER } from "./fixtures/vectors";

describe("TS <-> Solidity encoding vectors", () => {
  test("conditionHash", () => expect(conditionHash(V_CONDITION)).toBe("0xead29b5f97cc5be86c7df6bf24fdc20c87365f50bb7c5fdadcddcc50be718740")); // not-a-key
  test("CREATE_AUTH_TAG", () => expect(CREATE_AUTH_TAG).toBe("0xd779fdff838a8d8c331d4e72e05216f760fd4e13c76fe99da46cb43582c2ce4d")); // not-a-key
  test("createAuthNonce (nested struct encoding)", () =>
    expect(createAuthNonce(V_SENDER, V_PARAMS)).toBe("0xd567fad55ba2c098c3d950d82cd02a0ea8c3097057cf6c6be1feefd564f156ef")); // not-a-key
  test("escrow id", () => expect(escrowId(V_SENDER, V_SALT)).toBe(0x4bcb6fb78f8e84c24ec5aea2a4e23aaadeafd7a2f993b4dfc93403f7112a27b6n)); // not-a-key
  test("acceptAuthNonce", () =>
    expect(acceptAuthNonce(42n, V_ACCEPTOR, "0x0000000000000000000000000000000000000000")).toBe("0x7afe77ded2d66ceaedcb19dfc23440074556c941a48db3b8a76ae349ad522f51")); // not-a-key
  test("EIP-712 struct hashes", () => {
    expect(hashStruct({ types: claimTypes, primaryType: "Claim", data: { id: 42n, recipient: V_ACCEPTOR, conditionHash: conditionHash(V_CONDITION) } })).toBe("0x94c440ffa0461675bedb6380fc72cb9d34aeb8158a7f5f2ec034a5d72ba4e424"); // not-a-key
    expect(hashStruct({ types: decisionTypes, primaryType: "Decision", data: { id: 42n, action: 3, nonce: 7n, deadline: 1790000000n } })).toBe("0xf84744f6512e16e2743b7c84e0e36d31eedc5099917d67d99f1977286c8be305"); // not-a-key
  });
});
