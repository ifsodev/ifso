// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./utils/IfsoFixture.sol";

/// @notice Two-sided, invite-only challenges: both chip in, flat creation fee only, no % of stakes.
contract ChallengesTest is IfsoFixture {
    function _challenge(Condition memory c, address to, address link) internal returns (uint256 id) {
        CreateParams memory p = _params(c, to, link, 20e6, uint64(T0 + 10 days));
        p.twoSided = true;
        p.counterAmount = 20e6;
        p.acceptBy = uint64(T0 + 1 days);
        id = _create(p);
    }

    function test_NamedChallenge_RefereeToRecipient_TakesBothStakes() public {
        uint256 id = _challenge(_referee(referee), recipient, address(0));
        vm.prank(referee);
        vm.expectRevert(IIfsoEscrow.NotAccepted.selector);
        escrow.refereeDecide(id, true);

        vm.prank(attacker);
        vm.expectRevert(IIfsoEscrow.NotAuthorized.selector);
        escrow.accept(id, "", address(0));

        uint256 rb = usdg.balanceOf(recipient);
        vm.prank(recipient);
        escrow.accept(id, "", address(0));
        assertEq(rb - usdg.balanceOf(recipient), 20e6, "acceptor pays stake only, no fee");

        vm.prank(referee);
        escrow.refereeDecide(id, true);
        assertEq(usdg.balanceOf(recipient) - (rb - 20e6), 40e6, "recipient receives both stakes in full");
    }

    function test_NamedChallenge_RefereeToSender() public {
        uint256 id = _challenge(_referee(referee), recipient, address(0));
        vm.prank(recipient);
        escrow.accept(id, "", address(0));
        uint256 sb = usdg.balanceOf(sender);
        vm.prank(referee);
        escrow.refereeDecide(id, false);
        assertEq(usdg.balanceOf(sender) - sb, 40e6, "sender side receives both stakes");
        assertTrue(_status(id) == Status.RETURNED, "returned");
    }

    function test_LinkChallenge_AcceptNeedsLinkSignature() public {
        uint256 id = _challenge(_referee(referee), address(0), linkKey);
        bytes memory sig = _acceptSig(linkPk, id, recipientEoa);
        vm.prank(attacker);
        vm.expectRevert(IIfsoEscrow.BadSignature.selector); // signature is bound to the acceptor
        escrow.accept(id, sig, address(0));
        vm.prank(recipientEoa);
        escrow.accept(id, sig, address(0));
        assertEq(escrow.getEscrow(id).recipient, recipientEoa, "acceptor bound");
        // claim() cannot be used on challenges
        bytes memory claimSig = _claimSig(linkPk, id, attacker);
        vm.expectRevert(IIfsoEscrow.NotAuthorized.selector);
        escrow.claim(id, attacker, claimSig);
    }

    function test_AcceptWithAuthorization_Gasless() public {
        uint256 id = _challenge(_referee(referee), address(0), linkKey);
        bytes memory linkSig = _acceptSig(linkPk, id, recipientEoa);
        bytes32 nonce = escrow.acceptAuthNonce(id, recipientEoa, address(0));
        bytes memory auth = _usdgAuthSig(recipientPk, recipientEoa, address(escrow), 20e6, T0 - 1, T0 + 1 hours, nonce);
        vm.prank(keeper);
        escrow.acceptWithAuthorization(id, recipientEoa, linkSig, address(0), T0 - 1, T0 + 1 hours, auth);
        assertEq(usdg.balanceOf(address(escrow)), 40e6, "both stakes held");
    }

    function test_Unaccepted_RefundAfterAcceptWindow() public {
        uint256 id = _challenge(_referee(referee), recipient, address(0));
        vm.expectRevert(IIfsoEscrow.NotExpired.selector);
        escrow.refund(id, false, false);
        vm.warp(T0 + 1 days + 1);
        vm.prank(recipient);
        vm.expectRevert(IIfsoEscrow.AcceptWindowClosed.selector);
        escrow.accept(id, "", address(0));
        uint256 sb = usdg.balanceOf(sender);
        escrow.refund(id, false, false);
        assertEq(usdg.balanceOf(sender) - sb, 20e6, "creator refunded");
    }

    function test_AcceptedThenExpired_EachGetsOwnStakeBack() public {
        uint256 id = _challenge(_referee(referee), recipient, address(0));
        vm.prank(recipient);
        escrow.accept(id, "", alt); // acceptor's own refund destination
        vm.warp(T0 + 10 days);
        uint256 sb = usdg.balanceOf(sender);
        escrow.refund(id, false, false);
        assertEq(usdg.balanceOf(sender) - sb, 20e6, "sender own stake");
        assertEq(usdg.balanceOf(alt), 20e6, "acceptor own stake to its refund address");
        assertTrue(_status(id) == Status.VOIDED, "voided");
    }

    function test_CancelOnlyBeforeAccept() public {
        uint256 id = _challenge(_referee(referee), recipient, address(0));
        vm.prank(recipient);
        escrow.accept(id, "", address(0));
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.NotCancellable.selector);
        escrow.cancel(id);

        uint256 id2 = _challenge(_referee(referee), recipient, address(0));
        vm.prank(sender);
        escrow.cancel(id2);
        assertTrue(_status(id2) == Status.CANCELLED, "cancelled before accept");
    }

    function test_ChallengeShapeRules() public {
        CreateParams memory p = _params(_time(uint64(T0 + 1 days)), recipient, address(0), 20e6, uint64(T0 + 10 days));
        p.twoSided = true;
        p.counterAmount = 20e6;
        p.acceptBy = uint64(T0 + 12 hours);
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.InvalidParams.selector); // TIME makes no sense as a challenge
        escrow.create(p);

        p.condition = _parties();
        p.salt = bytes32(uint256(999));
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.InvalidParams.selector); // honor-system mode not allowed for challenges
        escrow.create(p);

        p.condition = _referee(referee);
        p.cancellable = true;
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.InvalidParams.selector);
        escrow.create(p);

        p.cancellable = false;
        p.condition = _referee(recipient); // referee cannot be a party
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.InvalidParams.selector);
        escrow.create(p);
    }

    function test_PriceChallenge_FalseGivesSenderPot() public {
        uint64 dl = uint64(T0 + 2 days);
        uint256 id = _challenge(_priceAt(200e8, OP_GTE, dl), recipient, address(0));
        vm.prank(recipient);
        escrow.accept(id, "", address(0));
        uint80 r = nvdaFeed.push(190e8, dl - 10 minutes);
        vm.warp(dl + 1);
        uint256 sb = usdg.balanceOf(sender);
        escrow.settle(id, _proof(r), false);
        assertEq(usdg.balanceOf(sender) - sb, 40e6, "sender side took the pot");
    }

    /// @notice Two-sided TOUCH is refused (R1-M2): TOUCH never ends FALSE, so the sender could never win, and the
    ///         invitee could accept after a cross. Challenges use AT_DEADLINE (DECISIONS).
    function test_TouchChallenge_RefusedAtCreation() public {
        uint64 dl = uint64(T0 + 3 days);
        CreateParams memory p =
            _params(_priceTouch(200e8, OP_GTE, uint64(T0), dl), recipient, address(0), 20e6, uint64(dl + 1 days));
        p.twoSided = true;
        p.counterAmount = 20e6;
        p.acceptBy = uint64(T0 + 1 days);
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);
    }

    function test_AtDeadlineChallenge_AcceptByMustPrecedeDeadline() public {
        uint64 dl = uint64(T0 + 2 days);
        CreateParams memory p = _params(_priceAt(200e8, OP_GTE, dl), recipient, address(0), 20e6, uint64(T0 + 10 days));
        p.twoSided = true;
        p.counterAmount = 20e6;
        p.acceptBy = dl + 1;
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);
    }

    function test_OutcomeChallenge_AcceptByMustPrecedeKickoff() public {
        uint64 kickoff = uint64(T0 + 1 days);
        vm.prank(creator);
        bytes32 qid = resolver.createQuestion(keccak256("match"), kickoff, kickoff + 3 hours, 3, "");
        CreateParams memory p = _params(_outcome(qid, 1 << 1), recipient, address(0), 20e6, uint64(T0 + 10 days));
        p.twoSided = true;
        p.counterAmount = 20e6;
        p.acceptBy = kickoff + 1;
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);

        p.acceptBy = kickoff - 1 hours;
        uint256 id = _create(p);
        assertTrue(_status(id) == Status.OPEN, "ok before kickoff");

        // one-sided gifts may still be created after kickoff (only the sender bears that)
        vm.warp(kickoff + 10 minutes);
        uint256 gift = _create(_named(_outcome(qid, 1 << 1), uint64(T0 + 10 days)));
        assertTrue(_status(gift) == Status.OPEN, "one-sided after kickoff ok");
    }
}
