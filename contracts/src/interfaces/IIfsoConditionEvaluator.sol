// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Condition, Verdict} from "../libraries/IfsoTypes.sol";

interface IIfsoConditionEvaluator {
    /// @notice Reverts if `c` is not a valid, launch-supported condition for an escrow created now
    ///         with `expiry`. Registry checks (allowed feeds / price ids / resolvers) happen ONLY here,
    ///         so delisting a source never strands an existing escrow.
    /// @param acceptBy two-sided challenges only (0 otherwise): the invitee must not be able to accept once the
    ///        answer is knowable (PRICE AT_DEADLINE: acceptBy <= deadline; OUTCOME: acceptBy <= closeTime).
    function validate(Condition calldata c, uint64 expiry, uint64 acceptBy) external view;

    /// @notice Evaluates TIME / PRICE / OUTCOME conditions. APPROVE is resolved inside the escrow.
    /// @param activeFrom escrow creation time, or acceptance time for challenges (TOUCH windows never start
    ///        before it, so a challenge cannot be accepted after a touch already happened)
    /// @param proof     CHAINLINK: abi.encode(uint80 roundId) ; PYTH: abi.encode(bytes[] updateData) ; else empty
    /// @param refundee  receives any unused msg.value (Pyth update fee overpayment)
    function evaluate(Condition calldata c, uint64 activeFrom, bytes calldata proof, address refundee)
        external
        payable
        returns (Verdict);
}
