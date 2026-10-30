// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./utils/IfsoFixture.sol";

/// @notice Cross-language parity: the constants below are printed by app/scripts/print-vectors.ts from
///         app/test/fixtures/vectors.ts (viem encoding). app/test/parity.test.ts asserts the same
///         constants, so a drift in either the Solidity or the TypeScript encoding fails one of the suites.
contract VectorsTest is IfsoFixture {
    address internal constant V_SENDER = 0x00000000000000000000000000000000000A11cE;
    address internal constant V_RECIPIENT = 0x0000000000000000000000000000000000000B0b;
    address internal constant V_ACCEPTOR = 0x000000000000000000000000000000000000aC00;
    bytes32 internal constant V_SALT = 0x1111111111111111111111111111111111111111111111111111111111111111; // not-a-key

    bytes32 internal constant CONDITION_HASH = 0xead29b5f97cc5be86c7df6bf24fdc20c87365f50bb7c5fdadcddcc50be718740; // not-a-key
    bytes32 internal constant CREATE_AUTH_NONCE = 0xd567fad55ba2c098c3d950d82cd02a0ea8c3097057cf6c6be1feefd564f156ef; // not-a-key
    uint256 internal constant ESCROW_ID = 0x4bcb6fb78f8e84c24ec5aea2a4e23aaadeafd7a2f993b4dfc93403f7112a27b6; // not-a-key
    bytes32 internal constant ACCEPT_AUTH_NONCE = 0x7afe77ded2d66ceaedcb19dfc23440074556c941a48db3b8a76ae349ad522f51; // not-a-key
    bytes32 internal constant CREATE_TAG = 0xd779fdff838a8d8c331d4e72e05216f760fd4e13c76fe99da46cb43582c2ce4d; // not-a-key
    bytes32 internal constant CLAIM_STRUCT = 0x94c440ffa0461675bedb6380fc72cb9d34aeb8158a7f5f2ec034a5d72ba4e424; // not-a-key
    bytes32 internal constant DECISION_STRUCT = 0xf84744f6512e16e2743b7c84e0e36d31eedc5099917d67d99f1977286c8be305; // not-a-key

    function _vCondition() internal pure returns (Condition memory c) {
        c.kind = Kind.PRICE;
        c.mode = PRICE_AT_DEADLINE;
        c.op = OP_GTE;
        c.source = SRC_CHAINLINK;
        c.target = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
        c.stockToken = 0x00000000000000000000000000000000000057Cc;
        c.threshold = 20_000_000_000;
        c.multiplier = 1e18;
        c.deadline = 1_790_300_000;
        c.maxStale = 90_000;
        c.holdWindow = 259_200;
    }

    function _vParams() internal pure returns (CreateParams memory p) {
        p.amount = 20e6;
        p.recipient = V_RECIPIENT;
        p.altRefundTo = 0x0000000000000000000000000000000000000A17;
        p.expiry = 1_790_900_000;
        p.cancellable = true;
        p.salt = V_SALT;
        p.condition = _vCondition();
    }

    function test_ConditionHashParity() public view {
        assertEq(escrow.conditionHashOf(_vCondition()), CONDITION_HASH, "conditionHash");
    }

    function test_CreateAuthNonceParity() public view {
        assertEq(escrow.CREATE_AUTH_TAG(), CREATE_TAG, "tag");
        assertEq(escrow.createAuthNonce(V_SENDER, _vParams()), CREATE_AUTH_NONCE, "createAuthNonce");
    }

    function test_IdAndAcceptNonceParity() public view {
        assertEq(escrow.idFor(V_SENDER, V_SALT), ESCROW_ID, "id");
        assertEq(escrow.acceptAuthNonce(42, V_ACCEPTOR, address(0)), ACCEPT_AUTH_NONCE, "acceptAuthNonce");
    }

    function test_Eip712StructParity() public view {
        assertEq(
            keccak256(abi.encode(escrow.CLAIM_TYPEHASH(), uint256(42), V_ACCEPTOR, CONDITION_HASH)),
            CLAIM_STRUCT,
            "claim"
        );
        assertEq(
            keccak256(
                abi.encode(escrow.DECISION_TYPEHASH(), uint256(42), uint8(3), uint256(7), uint256(1_790_000_000))
            ),
            DECISION_STRUCT,
            "decision"
        );
    }
}
