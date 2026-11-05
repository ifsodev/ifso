// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../utils/IfsoFixture.sol";

/// Audit 2026-11-05 I-16: `acceptBy <= closeTime` and `earliestResolve >= closeTime` let an accept and a proposal
/// land in the same second (acceptBy == closeTime == earliestResolve). Both bounds are now strict: an accept happens
/// at the latest at closeTime - 1 and a proposal at the earliest at closeTime + 1.
contract AuditI16StrictTimesTest is IfsoFixture {
    uint64 internal kickoff;

    function setUp() public override {
        super.setUp();
        kickoff = uint64(T0 + 1 days);
    }

    function test_I16_Resolver_EarliestResolveMustBeAfterCloseTime() public {
        vm.startPrank(creator);
        vm.expectRevert(IfsoOutcomeResolver.BadQuestion.selector);
        resolver.createQuestion(keccak256("same-second"), kickoff, kickoff, 3, "");
        bytes32 qid = resolver.createQuestion(keccak256("next-second"), kickoff, kickoff + 1, 3, "");
        vm.stopPrank();
        (,, uint64 closeTime, uint64 earliest) = resolver.questionInfo(qid);
        assertTrue(earliest > closeTime, "earliestResolve strictly after closeTime");
    }

    function test_I16_Evaluator_AcceptByMustBeBeforeCloseTime() public {
        vm.prank(creator);
        bytes32 qid = resolver.createQuestion(keccak256("match"), kickoff, kickoff + 3 hours, 3, "");
        CreateParams memory p = _params(_outcome(qid, 1 << 1), recipient, address(0), 20e6, uint64(T0 + 10 days));
        p.twoSided = true;
        p.counterAmount = 20e6;
        p.acceptBy = kickoff; // accept allowed in the closeTime second
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);

        p.acceptBy = kickoff - 1;
        uint256 id = _create(p);
        assertTrue(_status(id) == Status.OPEN, "acceptBy = closeTime - 1 is fine");
    }

    /// The window the audit described cannot be built at all: accept, propose in one second.
    function testFuzz_I16_AcceptAndProposeNeverShareASecond(uint32 closeIn, uint32 gap, uint32 acceptBefore) public {
        uint64 close = uint64(block.timestamp) + 2 + (closeIn % 3 days);
        uint64 earliest = close + (gap % 6 hours);
        uint64 acceptBy = close - (acceptBefore % 2);
        vm.prank(creator);
        try resolver.createQuestion(keccak256(abi.encode(closeIn, gap)), close, earliest, 3, "") returns (bytes32 q) {
            CreateParams memory p = _params(_outcome(q, 1 << 1), recipient, address(0), 20e6, uint64(T0 + 30 days));
            p.twoSided = true;
            p.counterAmount = 20e6;
            p.acceptBy = acceptBy;
            vm.prank(sender);
            try escrow.create(p) {
                assertTrue(acceptBy < earliest, "last accept second precedes the first proposal second");
                assertTrue(acceptBy + 1 < earliest, "at least one full second between them");
            } catch {}
        } catch {
            assertTrue(earliest <= close, "only earliestResolve <= closeTime is refused");
        }
    }
}
