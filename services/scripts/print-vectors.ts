// Prints the cross-language parity vectors asserted by contracts/test/Vectors.t.sol and test/parity.test.ts.
import { conditionHash, createAuthNonce, acceptAuthNonce, escrowId, CREATE_AUTH_TAG } from "../src/core/condition";
import { V_CONDITION, V_PARAMS, V_SENDER, V_SALT, V_ACCEPTOR } from "../test/fixtures/vectors";
console.log("conditionHash", conditionHash(V_CONDITION));
console.log("createAuthNonce", createAuthNonce(V_SENDER, V_PARAMS));
console.log("escrowId", "0x" + escrowId(V_SENDER, V_SALT).toString(16).padStart(64, "0"));
console.log("acceptAuthNonce", acceptAuthNonce(42n, V_ACCEPTOR, "0x0000000000000000000000000000000000000000"));
console.log("tag", CREATE_AUTH_TAG);
import { hashStruct } from "viem";
import { claimTypes, decisionTypes } from "../src/core/typedData";
console.log("claimStruct", hashStruct({ types: claimTypes, primaryType: "Claim", data: { id: 42n, recipient: V_ACCEPTOR, conditionHash: conditionHash(V_CONDITION) } }));
console.log("decisionStruct", hashStruct({ types: decisionTypes, primaryType: "Decision", data: { id: 42n, action: 3, nonce: 7n, deadline: 1790000000n } }));
