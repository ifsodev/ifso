// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./utils/IfsoFixture.sol";
import {Verdict} from "../src/libraries/IfsoTypes.sol";

/// @dev Every function reverts: a Stock Token whose multiplier cannot be read.
contract UnreadableToken {
    fallback() external {
        revert();
    }
}

/// @notice Boundary and negative tests that kill the mutants the first mutation run let survive (see
///         tools/mutants.py and .audit-grade/mutation.md). Each test names the mutant it kills; every boundary is
///         tested on both sides, to the second.
contract MutationKillersTest is IfsoFixture {
    uint64 internal dl;

    function setUp() public override {
        super.setUp();
        dl = uint64(T0 + 2 days);
    }

    function _open(int256 th) internal returns (uint256) {
        return _create(_named(_priceAt(th, OP_GTE), uint64(dl + 4 days)));
    }

    function _priceAt(int256 th, uint8 op) internal view returns (Condition memory) {
        return super._priceAt(th, op, dl);
    }

    // ------------------------------------------------------------------------------------------ evaluator
    /// kills M1-a: acceptBy + maxStale == deadline is refused, one second earlier is accepted
    function test_Challenge_AcceptByPlusMaxStaleEqualDeadline_Refused() public {
        Condition memory c = _priceAt(200e8, OP_GTE);
        CreateParams memory p = _params(c, recipient, address(0), 20e6, uint64(dl + 4 days));
        p.twoSided = true;
        p.counterAmount = 20e6;
        p.acceptBy = uint64(dl - c.maxStale);
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);
        p.acceptBy = uint64(dl - c.maxStale - 1);
        _create(p);
    }

    /// kills E-threshold: a zero threshold is refused
    function test_Validate_ZeroThresholdRefused() public {
        Condition memory c = _priceAt(0, OP_GTE);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        evaluator.validate(c, uint64(dl + 4 days), 0);
    }

    /// kills E-after-deadline: at the deadline second itself nothing settles
    function test_AtDeadline_NotSettleableAtTheDeadlineSecond() public {
        uint256 id = _open(200e8);
        uint80 r = nvdaFeed.push(250e8, dl - 5 minutes);
        vm.warp(dl);
        vm.expectRevert(IIfsoEscrow.ConditionPending.selector);
        escrow.settle(id, _proof(r), false);
        vm.warp(dl + 1);
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RELEASED, "settles one second later");
    }

    /// kills E-round-after: a round stamped exactly at the deadline is the price at the deadline
    function test_AtDeadline_RoundStampedAtTheDeadlineDecides() public {
        uint256 id = _open(200e8);
        uint80 r = nvdaFeed.push(250e8, dl);
        vm.warp(dl + 1);
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RELEASED, "round at the deadline decides");
    }

    /// kills E-last-round: with a later round stamped exactly at the deadline, the earlier one is not the last
    function test_AtDeadline_EarlierRoundIsNotLastWhenNextIsAtTheDeadline() public {
        uint256 id = _open(200e8);
        uint80 r1 = nvdaFeed.push(250e8, dl - 10 minutes);
        uint80 r2 = nvdaFeed.push(100e8, dl);
        vm.warp(dl + 1);
        vm.expectRevert(IIfsoEscrow.ConditionPending.selector);
        escrow.settle(id, _proof(r1), false);
        escrow.settle(id, _proof(r2), false); // the round at the deadline: 100 < 200 => FALSE
        assertTrue(_status(id) == Status.RETURNED, "decided on the last round");
    }

    /// kills E-stale: a round exactly maxStale old at the deadline is still fresh
    function test_AtDeadline_RoundExactlyMaxStaleOldIsFresh() public {
        uint256 id = _open(200e8);
        uint80 r = nvdaFeed.push(250e8, dl - 1 hours); // maxStale = 1 hours
        vm.warp(dl + 1);
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RELEASED, "fresh at the limit");
    }

    /// kills E-hold: a first print exactly holdWindow after the deadline still decides
    function test_AtDeadline_PrintExactlyAtTheHoldLimitDecides() public {
        uint256 id = _open(200e8);
        uint80 r1 = nvdaFeed.push(100e8, dl - 2 hours); // stale at the deadline
        nvdaFeed.push(250e8, dl + 3 days); // holdWindow = 3 days exactly
        vm.warp(dl + 3 days);
        escrow.settle(id, _proof(r1), false);
        assertTrue(_status(id) == Status.RELEASED, "decided on the print at the limit");
    }

    /// kills E-hold-wait: with no print, the result is still PENDING at deadline + holdWindow and VOID one second later
    function test_AtDeadline_NoPrint_PendingUntilTheHoldLimitThenVoid() public {
        uint256 id = _open(200e8);
        uint80 r1 = nvdaFeed.push(250e8, dl - 2 hours);
        vm.warp(dl + 3 days);
        vm.expectRevert(IIfsoEscrow.ConditionPending.selector);
        escrow.settle(id, _proof(r1), false);
        vm.warp(dl + 3 days + 1);
        escrow.settle(id, _proof(r1), false);
        assertTrue(_status(id) == Status.RETURNED, "VOID refunds");
    }

    /// kills E-sequencer-grace: restarted exactly the grace period ago still counts as down, one second more is up
    function test_Sequencer_GraceBoundaryToTheSecond() public {
        uint256 id = _open(200e8);
        uint80 r = nvdaFeed.push(250e8, dl - 5 minutes);
        vm.warp(dl + 1);
        seq.set(0, dl + 1 - 1 hours);
        vm.expectRevert(IfsoConditionEvaluator.SequencerDown.selector);
        escrow.settle(id, _proof(r), false);
        seq.set(0, dl + 1 - 1 hours - 1);
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RELEASED, "settles one second past the grace");
    }

    /// kills E-sequencer-down: a feed that reports down blocks settlement even when its start time is old
    function test_Sequencer_ReportedDownBlocksEvenWhenStartedLongAgo() public {
        uint256 id = _open(200e8);
        uint80 r = nvdaFeed.push(250e8, dl - 5 minutes);
        vm.warp(dl + 1);
        seq.set(1, T0 - 2 days);
        vm.expectRevert(IfsoConditionEvaluator.SequencerDown.selector);
        escrow.settle(id, _proof(r), false);
    }

    /// kills L1-e: a multiplier that cannot be read fails closed (VOID), never decides
    function test_Multiplier_UnreadableFailsClosedToVoid() public {
        uint256 id = _open(200e8);
        uint80 r = nvdaFeed.push(250e8, dl - 5 minutes);
        vm.etch(address(nvda), address(new UnreadableToken()).code);
        vm.warp(dl + 1);
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RETURNED, "VOID, not RELEASED, when the multiplier is unreadable");
    }

    /// kills E-outcome-void: a final outcome 0 (panel says VOID) evaluates to VOID, never FALSE
    function test_Outcome_FinalZeroEvaluatesToVoid() public {
        uint64 closeAt = uint64(T0 + 1 days);
        vm.prank(creator);
        bytes32 qv = resolver.createQuestion(keccak256("v"), closeAt, closeAt + 1 hours, 3, "ipfs://v");
        vm.warp(closeAt + 1 hours);
        vm.prank(keeper);
        resolver.propose(qv, 1, bytes32(0));
        vm.prank(recipient);
        resolver.dispute(qv, bytes32(0));
        vm.prank(panel);
        resolver.panelResolve(qv, 0);
        Condition memory c = _outcome(qv, 1 << 1);
        Verdict v = evaluator.evaluate(c, 0, "", address(this));
        assertTrue(v == Verdict.VOID, "outcome 0 is VOID");
    }

    // ------------------------------------------------------------------------------------------ escrow
    function _challengeNamed() internal returns (uint256 id, uint64 acceptBy) {
        acceptBy = uint64(T0 + 1 days);
        CreateParams memory p = _params(_referee(referee), recipient, address(0), 20e6, uint64(T0 + 10 days));
        p.twoSided = true;
        p.counterAmount = 20e6;
        p.acceptBy = acceptBy;
        id = _create(p);
    }

    function _challengeLink() internal returns (uint256 id) {
        CreateParams memory p = _params(_referee(referee), address(0), linkKey, 20e6, uint64(T0 + 10 days));
        p.twoSided = true;
        p.counterAmount = 20e6;
        p.acceptBy = uint64(T0 + 1 days);
        id = _create(p);
    }

    /// kills X-acceptby-expiry: acceptBy may not reach the expiry
    function test_Challenge_AcceptByAtOrAfterExpiryRefused() public {
        CreateParams memory p = _params(_referee(referee), recipient, address(0), 20e6, uint64(T0 + 10 days));
        p.twoSided = true;
        p.counterAmount = 20e6;
        p.acceptBy = p.expiry;
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.InvalidParams.selector);
        escrow.create(p);
        p.acceptBy = p.expiry - 1;
        _create(p);
    }

    /// kills X-accept-window: accepting is allowed through the acceptBy second itself
    function test_Accept_AllowedAtTheAcceptByInstant() public {
        (uint256 id, uint64 acceptBy) = _challengeNamed();
        vm.warp(acceptBy);
        vm.prank(recipient);
        escrow.accept(id, "", address(0));
        assertEq(usdg.balanceOf(address(escrow)), 40e6, "both stakes held");
    }

    /// kills X-accept-twice: a challenge is accepted once
    function test_Accept_Twice_Reverts() public {
        (uint256 id,) = _challengeNamed();
        vm.prank(recipient);
        escrow.accept(id, "", address(0));
        vm.prank(recipient);
        vm.expectRevert(IIfsoEscrow.AlreadyAccepted.selector);
        escrow.accept(id, "", address(0));
        assertEq(usdg.balanceOf(address(escrow)), 40e6, "stake pulled once");
    }

    /// kills X-accept-self: the sender cannot accept its own link challenge
    function test_Accept_SenderOwnLinkChallenge_Refused() public {
        uint256 id = _challengeLink();
        bytes memory sig = _acceptSig(linkPk, id, sender);
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.BadRecipient.selector);
        escrow.accept(id, sig, address(0));
    }

    /// kills X-referee-acceptor: the referee cannot be a party
    function test_Accept_RefereeAsAcceptor_Refused() public {
        uint256 id = _challengeLink();
        bytes memory sig = _acceptSig(linkPk, id, referee);
        vm.prank(referee);
        vm.expectRevert(IIfsoEscrow.BadRecipient.selector);
        escrow.accept(id, sig, address(0));
    }

    /// kills X-settle-expired: settle fails at the expiry second (refund works from then)
    function test_Settle_RefusedAtTheExpirySecond_RefundAllowed() public {
        uint64 expiry = uint64(T0 + 5 days);
        uint256 id = _create(_named(_time(uint64(T0 + 1 days)), expiry));
        vm.warp(expiry);
        vm.expectRevert(IIfsoEscrow.Expired.selector);
        escrow.settle(id, "", false);
        escrow.refund(id, false, false);
        assertTrue(_status(id) == Status.RETURNED, "refunded at the expiry second");
    }

    /// kills X-refund-early: refund is refused one second before the expiry
    function test_Refund_RefusedOneSecondBeforeExpiry() public {
        uint64 expiry = uint64(T0 + 5 days);
        uint256 id = _create(_named(_time(uint64(T0 + 1 days)), expiry));
        vm.warp(expiry - 1);
        vm.expectRevert(IIfsoEscrow.NotExpired.selector);
        escrow.refund(id, false, false);
    }

    /// kills X-sig-deadline-refund: an expired refund-redirect signature is refused
    function test_RefundRedirectBySig_ExpiredRefused() public {
        uint256 id = _create(_named(_time(uint64(T0 + 1 days)), uint64(T0 + 5 days)));
        uint256 deadline = T0 + 1 hours;
        bytes memory sig = _sig(senderPk, escrow.hashRefundRedirect(id, alt, address(0), 0, deadline));
        vm.warp(deadline + 1);
        vm.expectRevert(IIfsoEscrow.SignatureExpired.selector);
        escrow.setRefundAddressesBySig(id, alt, address(0), deadline, sig);
    }

    /// kills X-refund-self: the escrow itself is never a refund destination
    function test_RefundAddresses_EscrowItselfRefused() public {
        uint256 id = _create(_named(_time(uint64(T0 + 1 days)), uint64(T0 + 5 days)));
        vm.startPrank(sender);
        vm.expectRevert(IIfsoEscrow.InvalidParams.selector);
        escrow.setRefundAddresses(id, address(escrow), address(0));
        vm.expectRevert(IIfsoEscrow.InvalidParams.selector);
        escrow.setRefundAddresses(id, alt, address(escrow));
        vm.stopPrank();
    }

    /// kills M4-g: an owed acceptor side can point its destination elsewhere and be paid there
    function test_Void_OwedAcceptorSide_CanRedirectThenIsPaid() public {
        address frozen = address(0xF2F2);
        usdg.setBlocked(frozen, true);
        (uint256 id,) = _challengeNamed();
        vm.prank(recipient);
        escrow.accept(id, "", frozen);
        vm.warp(T0 + 10 days);
        escrow.refund(id, false, false);
        assertEq(escrow.getEscrow(id).flags & 64, 64, "acceptor side owed");
        vm.prank(recipient);
        escrow.setCounterRefundTo(id, alt);
        uint256 b = usdg.balanceOf(alt);
        escrow.claimVoid(id, true, false);
        assertEq(usdg.balanceOf(alt) - b, 20e6, "paid to the new destination");
    }

    // ------------------------------------------------------------------------------------------ resolver
    uint64 internal close;
    uint64 internal earliest;
    bytes32 internal q;

    function _question() internal {
        close = uint64(T0 + 1 days);
        earliest = close + 1 hours;
        vm.prank(creator);
        q = resolver.createQuestion(keccak256("k"), close, earliest, 3, "ipfs://k");
    }

    /// kills R-finalize-early: an undisputed proposal finalizes only once the dispute window has fully passed
    function test_Resolver_FinalizeOneSecondEarlyRefused() public {
        _question();
        vm.warp(earliest);
        vm.prank(keeper);
        resolver.propose(q, 1, bytes32(0));
        vm.warp(earliest + 2 hours - 1);
        vm.expectRevert(IfsoOutcomeResolver.TooEarly.selector);
        resolver.finalize(q);
        vm.warp(earliest + 2 hours);
        resolver.finalize(q);
    }

    /// kills R-panel-window, R-timeout-early, R-bond-snapshot: panel and timeout boundaries to the second, and a
    /// proposal's bond is the one snapshotted when it was posted
    function test_Resolver_PanelWindowBoundaries_AndBondSnapshot() public {
        _question();
        vm.warp(earliest);
        vm.prank(keeper);
        resolver.propose(q, 1, bytes32(0)); // bond 100 USDG
        vm.prank(owner);
        resolver.setBondAmount(250e6); // changes later; the open proposal keeps its own
        uint256 before = usdg.balanceOf(recipient);
        vm.prank(recipient);
        resolver.dispute(q, bytes32(0));
        assertEq(before - usdg.balanceOf(recipient), 100e6, "disputer matches the snapshotted bond");
        uint256 dAt = block.timestamp;

        vm.warp(dAt + 72 hours - 1);
        vm.expectRevert(IfsoOutcomeResolver.TooEarly.selector);
        resolver.finalizeTimedOut(q);
        vm.warp(dAt + 72 hours);
        vm.prank(panel);
        vm.expectRevert(IfsoOutcomeResolver.WindowClosed.selector);
        resolver.panelResolve(q, 1);
        resolver.finalizeTimedOut(q);
        assertEq(resolver.claimableBond(keeper), 50e6, "proposer half bond back");
        assertEq(resolver.claimableBond(recipient), 50e6, "disputer half bond back");
    }

    /// kills R-withdraw-reset: a credited bond is withdrawn once
    function test_Resolver_WithdrawBondOnlyOnce() public {
        _question();
        vm.warp(earliest);
        vm.prank(keeper);
        resolver.propose(q, 1, bytes32(0));
        vm.warp(earliest + 2 hours);
        resolver.finalize(q);
        vm.startPrank(keeper);
        resolver.withdrawBond(address(0));
        vm.expectRevert(IfsoOutcomeResolver.NothingToWithdraw.selector);
        resolver.withdrawBond(address(0));
        vm.stopPrank();
    }

    /// kills R-panel-delay: a queued panel needs the full 48 hours
    function test_Resolver_PanelChangeNeedsTheFullDelay() public {
        vm.prank(owner);
        resolver.queuePanel(attacker);
        vm.warp(T0 + 2 hours);
        vm.expectRevert(IfsoOutcomeResolver.TooEarly.selector);
        resolver.applyPanel();
        vm.warp(T0 + 48 hours - 1);
        vm.expectRevert(IfsoOutcomeResolver.TooEarly.selector);
        resolver.applyPanel();
        vm.warp(T0 + 48 hours);
        resolver.applyPanel();
        assertEq(resolver.panel(), attacker, "rotated after exactly 48 h");
    }

    /// kills R-outcome-range: an outcome above the question's range is refused
    function test_Resolver_OutcomeAboveRangeRefused() public {
        _question();
        vm.warp(earliest);
        vm.prank(keeper);
        vm.expectRevert(IfsoOutcomeResolver.BadOutcome.selector);
        resolver.propose(q, 4, bytes32(0)); // numOutcomes = 3
        vm.prank(keeper);
        resolver.propose(q, 3, bytes32(0)); // the top outcome is fine
    }
}
