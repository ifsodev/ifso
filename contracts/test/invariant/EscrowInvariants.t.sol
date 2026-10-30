// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../utils/IfsoFixture.sol";
import {EscrowHandler, World} from "./EscrowHandler.sol";

/// @notice Handler-based invariants for IfsoEscrow (contracts/INVARIANTS.md, R4-R7).
///         Default profile: a quick pass. `FOUNDRY_PROFILE=invariant`: 10,000 runs x depth 50.
contract EscrowInvariantsTest is IfsoFixture {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    EscrowHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new EscrowHandler(
            escrow, evaluator, usdg, owner, World(nvdaFeed, nvda, resolver, creator, keeper, recipient, panel)
        );
        vm.prank(owner);
        escrow.setMaxAmount(1_000e6);
    }

    /// @dev forge-std-compatible discovery hooks (this repo vendors no forge-std).
    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory s) {
        bytes4[] memory sel = new bytes4[](24);
        sel[0] = EscrowHandler.createTime.selector;
        sel[1] = EscrowHandler.createApprove.selector;
        sel[2] = EscrowHandler.createChallenge.selector;
        sel[3] = EscrowHandler.accept.selector;
        sel[4] = EscrowHandler.claim.selector;
        sel[5] = EscrowHandler.settle.selector;
        sel[6] = EscrowHandler.approve.selector;
        sel[7] = EscrowHandler.decline.selector;
        sel[8] = EscrowHandler.refereeDecide.selector;
        sel[9] = EscrowHandler.cancel.selector;
        sel[10] = EscrowHandler.refund.selector;
        sel[11] = EscrowHandler.setRefund.selector;
        sel[12] = EscrowHandler.warp.selector;
        sel[13] = EscrowHandler.donate.selector;
        sel[14] = EscrowHandler.ownerAction.selector;
        sel[15] = EscrowHandler.createTime.selector; // creates weighted up so runs hold many escrows
        sel[16] = EscrowHandler.createPrice.selector;
        sel[17] = EscrowHandler.createOutcome.selector;
        sel[18] = EscrowHandler.pushPrice.selector;
        sel[19] = EscrowHandler.settlePrice.selector;
        sel[20] = EscrowHandler.resolverStep.selector;
        sel[21] = EscrowHandler.freeze.selector;
        sel[22] = EscrowHandler.setCounterRefund.selector;
        sel[23] = EscrowHandler.claimVoid.selector;
        s = new FuzzSelector[](1);
        s[0] = FuzzSelector(address(handler), sel);
    }

    function _obligations() internal view returns (uint256 sum) {
        uint256[] memory ids = handler.allIds();
        for (uint256 i; i < ids.length; ++i) {
            IIfsoEscrow.Escrow memory e = escrow.getEscrow(ids[i]);
            if (e.status == Status.OPEN || e.status == Status.MET) {
                sum += e.amount;
                if (e.flags & 2 != 0) sum += e.counterAmount; // F_ACCEPTED
            } else if (e.status == Status.VOIDED) {
                if (e.flags & 32 != 0) sum += e.amount; //        F_SENDER_OWED (R1-M4)
                if (e.flags & 64 != 0) sum += e.counterAmount; // F_COUNTER_OWED
            }
        }
    }

    /// R4: the escrow holds exactly what it owes (plus stray donations, which nobody can claim).
    function invariant_BalanceMatchesObligations() public view {
        assertEq(usdg.balanceOf(address(escrow)), _obligations() + handler.donated(), "balance == obligations");
    }

    /// R5: no status moves backwards; MET only ends RELEASED or RETURNED.
    function invariant_NoStatusRegression() public view {
        assertFalse(handler.statusRegressed(), string.concat("status regressed ", handler.regressionNote()));
    }

    /// R6: every OPEN/MET escrow past its expiry can be refunded by any caller, paused or not. With USDG freezes in
    ///     play: an accepted challenge always refunds (each side on its own, R1-M4); any other escrow refunds unless
    ///     every destination of its sender side is frozen (the sender's own money). Owed VOID sides are claimable as
    ///     soon as their destination can receive. Checks the escrows already expired now, on a throwaway state copy.
    function invariant_RefundAlwaysPossibleAfterExpiry() public {
        _refundAllExpired(block.timestamp, false);
    }

    /// R1-M1 / R1-M2: no challenge whose result could be known before acceptBy was ever created.
    function invariant_NoKnowableChallengeCreated() public view {
        assertFalse(handler.challengeRuleBroken(), "a TOUCH challenge or acceptBy + maxStale >= deadline was created");
    }

    /// R6 (end of every run): jump past every expiry and refund everything that is still open.
    function afterInvariant() public {
        uint256 maxExpiry;
        uint256[] memory ids = handler.allIds();
        for (uint256 i; i < ids.length; ++i) {
            uint64 x = escrow.getEscrow(ids[i]).expiry;
            if (x > maxExpiry) maxExpiry = x;
        }
        uint256 end = maxExpiry > block.timestamp ? maxExpiry : block.timestamp;
        _refundAllExpired(end, false); // with the run's freezes still in place
        _refundAllExpired(end, true); //  after the issuer lifts them: everything leaves
    }

    function _refundAllExpired(uint256 at, bool unfreeze) internal {
        uint256 snap = vm.snapshotState();
        vm.warp(at);
        vm.prank(owner);
        escrow.setCreationPaused(true);
        if (unfreeze) handler.unfreezeAll(); // the issuer lifts the freezes: then every unit must be able to leave
        uint256[] memory ids = handler.allIds();
        for (uint256 i; i < ids.length; ++i) {
            IIfsoEscrow.Escrow memory e = escrow.getEscrow(ids[i]);
            if ((e.status != Status.OPEN && e.status != Status.MET) || block.timestamp < e.expiry) continue;
            vm.prank(address(uint160(0xCA11E5 + i))); // a stranger
            try escrow.refund(ids[i], false, false) {}
            catch {
                assertFalse(e.flags & 3 == 3, "an accepted challenge's refund reverted (one side held the other)");
                assertTrue(usdg.blocked(e.refundTo), "refund reverted with a payable primary destination");
                if (e.altRefundTo == address(0) || usdg.blocked(e.altRefundTo)) continue; // sender's own money
                escrow.refund(ids[i], true, false);
            }
            Status s = escrow.getEscrow(ids[i]).status;
            assertTrue(s == Status.RETURNED || s == Status.VOIDED, "refund ends the escrow");
        }
        _claimOwed(ids);
        if (unfreeze && at >= _maxExpiry(ids)) {
            assertEq(usdg.balanceOf(address(escrow)), handler.donated(), "everything owed went out");
        }
        vm.revertToState(snap);
    }

    /// @dev Every owed VOID side whose destination can receive is paid by a stranger (R1-M4).
    function _claimOwed(uint256[] memory ids) internal {
        for (uint256 i; i < ids.length; ++i) {
            IIfsoEscrow.Escrow memory e = escrow.getEscrow(ids[i]);
            if (e.status != Status.VOIDED) continue;
            if (e.flags & 32 != 0 && !usdg.blocked(e.refundTo)) escrow.claimVoid(ids[i], false, false);
            if (e.flags & 64 != 0 && !usdg.blocked(e.counterRefundTo)) escrow.claimVoid(ids[i], true, false);
            e = escrow.getEscrow(ids[i]);
            if (e.flags & 32 != 0) assertTrue(usdg.blocked(e.refundTo), "owed sender side not claimable");
            if (e.flags & 64 != 0) assertTrue(usdg.blocked(e.counterRefundTo), "owed acceptor side not claimable");
        }
    }

    function _maxExpiry(uint256[] memory ids) internal view returns (uint256 m) {
        for (uint256 i; i < ids.length; ++i) {
            uint64 x = escrow.getEscrow(ids[i]).expiry;
            if (x > m) m = x;
        }
    }

    /// @notice Guards against a vacuous suite: a scripted walk through the handler reaches every path.
    function test_HandlerReachesEveryPath() public {
        handler.createTime(0, 10e6, 1 hours, 0, false, false); //  0 TIME named
        handler.createTime(1, 10e6, 1 hours, 0, true, false); //   1 TIME link
        handler.createTime(2, 10e6, 1 hours, 0, false, true); //   2 TIME cancellable
        handler.createApprove(0, 10e6, 5 days, false, false); //   3 PARTIES
        handler.createApprove(1, 10e6, 5 days, false, true); //    4 REFEREE
        handler.createChallenge(0, 10e6, 10e6, 1 days, 3 days, false); // 5 named challenge
        handler.createChallenge(1, 10e6, 10e6, 1 days, 3 days, true); //  6 link challenge
        handler.createTime(0, 1_100e6, 1 hours, 0, false, false); // above the cap: rejected
        assertEq(handler.idsLength(), 7, "creates");
        handler.accept(5, 0);
        handler.accept(6, 1);
        handler.claim(1, 2);
        handler.cancel(2);
        handler.approve(3, true);
        handler.approve(3, false);
        handler.refereeDecide(4, false);
        handler.refereeDecide(5, true);
        handler.donate(1e6);
        handler.ownerAction(2, 500e6, false);
        handler.setRefund(6, 0x1234);
        handler.warp(1 days);
        handler.settle(0);
        handler.settle(1);
        handler.createApprove(2, 10e6, 1 hours, false, false); // 7
        handler.decline(7);
        handler.warp(1 days);
        handler.warp(1 days);
        handler.warp(1 days);
        handler.warp(1 days);
        handler.refund(6, false, false, address(0xCAFE));
        string[11] memory k = [
            "create",
            "accept",
            "claim",
            "cancel",
            "approve",
            "referee",
            "settle",
            "decline",
            "refund",
            "setRefund",
            "create"
        ];
        for (uint256 i; i < k.length; ++i) {
            assertGt(handler.calls(bytes32(bytes(k[i]))), 0, k[i]);
        }
        assertEq(handler.calls("create"), 8, "cap rejected the oversized create");
        invariant_BalanceMatchesObligations();
        invariant_NoStatusRegression();
        invariant_OwnerCannotMoveFunds();
        afterInvariant();
    }

    /// @notice The R1 handler paths (PRICE, OUTCOME, freezes, claimVoid) are reachable and succeed.
    function test_HandlerReachesR1Paths() public {
        handler.createPrice(0, 10e6, 1 days, 0, 0, false); //      0 AT_DEADLINE one-sided
        handler.createPrice(1, 10e6, 1 days, 0, 1, false); //      1 TOUCH one-sided
        handler.createPrice(2, 30e6, 2 days, 3_600, 4, false); //  2 AT_DEADLINE challenge, acceptBy now + 1 h
        handler.createPrice(0, 10e6, 2 days, 3_600, 5, false); //  refused: two-sided TOUCH
        handler.createPrice(0, 10e6, 2 days, 50 hours - 1, 4, false); // refused: acceptBy = deadline (bounded 2 h + 2 d)
        handler.createOutcome(0, 10e6, 3 hours, 0, false, false); // 3 OUTCOME one-sided
        handler.createChallenge(0, 10e6, 10e6, 1 days, 3 days, false); // 4 referee challenge
        assertEq(handler.idsLength(), 5, "two knowable challenges refused");
        invariant_NoKnowableChallengeCreated();
        handler.accept(2, 0);
        handler.accept(4, 0);
        handler.pushPrice(100); // 250: crosses
        handler.settlePrice(1, 0); // TOUCH settles TRUE
        assertTrue(escrow.getEscrow(handler.ids(1)).status == Status.RELEASED, "touch released");
        // the challenge sender points its refund at an address the issuer then freezes; expiry VOIDs it
        handler.setRefund(4, 8); // freezable[4]
        handler.freeze(4, true);
        vm.warp(block.timestamp + 5 days);
        handler.refund(4, false, false, address(0xCAFE));
        IIfsoEscrow.Escrow memory e = escrow.getEscrow(handler.ids(4));
        assertTrue(e.status == Status.VOIDED && e.flags & 32 != 0, "sender side owed, acceptor paid");
        handler.claimVoid(4, false, false); // still frozen: no-op
        handler.freeze(4, false);
        handler.claimVoid(4, false, false);
        handler.resolverStep(0, 0, 1); // propose on the question
        string[5] memory k = ["createPrice", "settlePrice", "freeze", "claimVoid", "refund"];
        k[0] = "create";
        for (uint256 i; i < k.length; ++i) {
            assertGt(handler.calls(bytes32(bytes(k[i]))), 0, k[i]);
        }
        invariant_BalanceMatchesObligations();
        invariant_NoStatusRegression();
        afterInvariant();
    }

    /// R7: no owner function changes any escrow's balance, record or recipient.
    function invariant_OwnerCannotMoveFunds() public view {
        assertFalse(handler.ownerMovedFunds(), "owner action moved funds or changed an escrow");
    }
}
