// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./utils/IfsoFixture.sol";

/// @dev USDG stand-in whose transfer to one address burns ~3M gas, so a starved call can run out of gas inside it.
contract HungryUSDG is MockUSDG {
    address public hungryTo;

    function setHungry(address a) external {
        hungryTo = a;
    }

    function transfer(address to, uint256 amt) external override returns (bool) {
        if (to == hungryTo) {
            for (uint256 i; i < 50_000; ++i) {
                assembly {
                    pop(keccak256(0, 64))
                }
            }
        }
        _transfer(msg.sender, to, amt);
        return true;
    }
}

/// @notice Security review round 1: regression tests. The six PoCs from docs/reviews (round 1) FAILED on main 6fe2c16
///         and pass here; where the fix refuses the setup at creation, the PoC's expectation is inverted (the create
///         reverts) and a second test proves the property on a valid setup.
contract ReviewR1Test is IfsoFixture {
    uint8 internal constant F_SENDER_OWED = 32;
    uint8 internal constant F_COUNTER_OWED = 64;

    // =========================================================================================================
    // R1-M1: AT_DEADLINE challenge accepted after the deciding round is already published (market closed).
    //   Fix: validate requires acceptBy + maxStale < deadline, so the deciding round is always written after the
    //   last moment anyone can accept.
    // =========================================================================================================
    function test_R1_M1_AtDeadline_AcceptAfterResultKnown_MarketClosed() public {
        uint64 fridayClose = uint64(T0 + 1 days); // last equity print of the week
        uint64 deadline = fridayClose + 16 hours; // Saturday midday (no prints until Sunday evening)
        Condition memory c = _priceAt(200e8, OP_GTE, deadline);
        c.maxStale = 25 hours; // app default (builder.ts DEFAULTS.maxStale)
        CreateParams memory p = _params(c, recipient, address(0), 1_000e6, deadline + 3 days + 4 days);
        p.twoSided = true;
        p.counterAmount = 1_000e6;
        p.acceptBy = deadline; // the PoC's setup: now refused at creation
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);

        // the latest acceptBy still allowed: one second before deadline - maxStale (Friday 11:00, before the close)
        p.acceptBy = deadline - c.maxStale - 1;
        uint256 id = _create(p);
        vm.warp(fridayClose);
        uint80 closeRound = nvdaFeed.pushNow(210e8); // the close, now after acceptBy
        vm.prank(recipient);
        vm.expectRevert(IIfsoEscrow.AcceptWindowClosed.selector);
        escrow.accept(id, "", address(0)); // cannot accept a known result
        vm.warp(deadline + 1);
        vm.expectRevert(IIfsoEscrow.NotAccepted.selector);
        escrow.settle(id, _proof(closeRound), false);
        assertTrue(_status(id) == Status.OPEN, "nobody accepted: the sender's stake refunds after acceptBy");
    }

    /// @notice Property: the create succeeds exactly when acceptBy + maxStale < deadline, and on any valid setup the
    ///         round that decides the result (fresh path) carries updatedAt > acceptBy.
    function testFuzz_R1_M1_DecidingRoundIsAfterAcceptBy(uint32 maxStaleIn, uint32 acceptIn, uint32 pushBack) public {
        uint64 deadline = uint64(T0 + 4 days);
        Condition memory c = _priceAt(200e8, OP_GTE, deadline);
        c.maxStale = uint32(1 hours + (maxStaleIn % (3 days - 1 hours)));
        uint64 acceptBy = uint64(T0 + 1 + (acceptIn % (4 days - 1)));
        CreateParams memory p = _params(c, recipient, address(0), 100e6, deadline + 3 days + 1 days);
        p.twoSided = true;
        p.counterAmount = 100e6;
        p.acceptBy = acceptBy;
        bool valid = uint256(acceptBy) + c.maxStale < deadline;
        vm.prank(sender);
        if (!valid) {
            vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
            escrow.create(p);
            return;
        }
        uint256 id = escrow.create(p);
        vm.prank(recipient);
        escrow.accept(id, "", address(0));
        // one print at some time before the deadline; settle on it
        uint64 at = uint64(T0 + (pushBack % (deadline - T0)));
        uint80 r = nvdaFeed.push(250e8, at);
        vm.warp(deadline + 1);
        try escrow.settle(id, _proof(r), false) {
            // decided on the fresh path: that round must be strictly after the last moment to accept
            assertGt(at, acceptBy, "deciding round written after acceptBy");
        } catch {}
    }

    // =========================================================================================================
    // R1-M2: two-sided TOUCH is a free option for the invitee. Fix: refused at creation.
    // =========================================================================================================
    function test_R1_M2_TouchChallenge_AcceptAfterCross_SenderCannotWin() public {
        uint64 dl = uint64(T0 + 3 days);
        CreateParams memory p =
            _params(_priceTouch(200e8, OP_GTE, uint64(T0), dl), recipient, address(0), 1_000e6, dl + 1 days);
        p.twoSided = true;
        p.counterAmount = 1_000e6;
        p.acceptBy = uint64(T0 + 2 days);
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);
        // one-sided TOUCH is unchanged
        p.twoSided = false;
        p.counterAmount = 0;
        p.acceptBy = 0;
        uint256 id = _create(p);
        assertTrue(_status(id) == Status.OPEN, "one-sided TOUCH still allowed");
    }

    // =========================================================================================================
    // R1-M3: OUTCOME expiry minimum ignored the panel window. Fix: expiry >= earliestResolve + disputeWindow +
    //   panelWindow + 1 day, so a panel answer at the very end of its window still settles before expiry.
    // =========================================================================================================
    function test_R1_M3_Outcome_DisputeRunsOutTheClock() public {
        uint64 kickoff = uint64(T0 + 1 days);
        uint64 earliest = kickoff + 150 minutes;
        vm.prank(creator);
        bytes32 qid = resolver.createQuestion(keccak256("ARS-CHE"), kickoff, earliest, 3, "");
        // the old contract minimum (earliest + disputeWindow + 1 day) is refused now
        CreateParams memory p =
            _params(_outcome(qid, 1 << 1), recipient, address(0), 1_000e6, earliest + 2 hours + 1 days);
        p.twoSided = true;
        p.counterAmount = 1_000e6;
        p.acceptBy = kickoff - 1 hours;
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);
        p.expiry = earliest + evaluator.PROPOSAL_GRACE() + 2 hours + 72 hours + 1 days - 1; // R2-L2 adds the grace
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);

        // the new minimum
        p.expiry = earliest + evaluator.PROPOSAL_GRACE() + 2 hours + 72 hours + 1 days;
        uint256 id = _create(p);
        vm.prank(recipient);
        escrow.accept(id, "", address(0));

        vm.warp(earliest);
        vm.prank(keeper);
        resolver.propose(qid, 1, keccak256("sources")); // HOME, correct
        usdg.mint(attacker, 100e6);
        vm.startPrank(attacker); // the losing side disputes at the last second of the dispute window
        usdg.approve(address(resolver), type(uint256).max);
        vm.warp(earliest + 2 hours - 1);
        resolver.dispute(qid, keccak256("nonsense"));
        vm.stopPrank();
        vm.warp(earliest + 2 hours - 1 + 72 hours - 1); // panel answers at the last second of its window
        vm.prank(panel);
        resolver.panelResolve(qid, 1);
        uint256 rb = usdg.balanceOf(recipient);
        escrow.settle(id, "", false); // still before expiry
        assertEq(usdg.balanceOf(recipient) - rb, 2_000e6, "winner receives the pot once the panel confirms");
    }

    // =========================================================================================================
    // R1-L1: a multiplier change after the deciding price must not VOID a decided result while it is still
    //   pending. Since R2-L1, a change that is already in force at settle VOIDs (fail closed: the value it replaced,
    //   which was in force at the price, is no longer visible), so settle before the announced effectiveAt.
    // =========================================================================================================
    function test_R1_L1_PendingSplitAfterDeadline_Releases() public {
        uint64 dl = uint64(T0 + 2 days);
        uint256 id = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        uint80 r = nvdaFeed.push(250e8, dl - 10 minutes); // in force at the deadline: TRUE
        nvda.schedule(2e18, dl + 3 hours); // corporate action announced after creation, effective after the deadline
        vm.warp(dl + 2 hours); // keeper settles a little late, still before the action
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RELEASED, "deadline price was pre-split and decided: should release");
    }

    /// @notice Once the change is in force at settle (lazy or applied token), the result VOIDs (R2-L1).
    function test_R1_L1_AppliedChangeBeforeSettle_VoidsSinceR2L1() public {
        uint64 dl = uint64(T0 + 2 days);
        uint256 id = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        uint80 r = nvdaFeed.push(250e8, dl - 10 minutes);
        nvda.schedule(2e18, dl + 1 hours);
        vm.warp(dl + 2 hours);
        nvda.setMultiplier(2e18); // applied
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RETURNED, "change in force before settle: VOID since R2-L1");
    }

    /// @notice A change effective at or before the deciding price still VOIDs (lazy and applied tokens), and an
    ///         unexplained change (no schedule after the price) VOIDs: fail closed.
    function test_R1_L1_ChangeAtOrBeforeDecidingRound_Voids() public {
        uint64 dl = uint64(T0 + 2 days);
        // lazy: schedule effective before the deciding round, not yet reflected by uiMultiplier
        uint256 a = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        uint256 b = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        uint256 d = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        uint80 r = nvdaFeed.push(250e8, dl - 10 minutes);
        nvda.schedule(2e18, dl - 10 minutes); // effective exactly at the deciding round
        vm.warp(dl + 2 hours);
        uint256 sb = usdg.balanceOf(sender);
        escrow.settle(a, _proof(r), false);
        assertTrue(_status(a) == Status.RETURNED, "lazy change at the deciding round: VOID");
        nvda.setMultiplier(2e18); // applied
        escrow.settle(b, _proof(r), false);
        assertTrue(_status(b) == Status.RETURNED, "applied change at the deciding round: VOID");
        nvda.schedule(0, 0); // change visible but no schedule proves it came after the price
        escrow.settle(d, _proof(r), false);
        assertTrue(_status(d) == Status.RETURNED, "unexplained change: VOID");
        assertEq(usdg.balanceOf(sender) - sb, 60e6, "all three refunded");
    }

    /// @notice TOUCH: a cross before a corporate action stays TRUE.
    function test_R1_L1_TouchCrossBeforeChange_Releases() public {
        uint64 dl = uint64(T0 + 3 days);
        uint256 id = _create(_named(_priceTouch(200e8, OP_GTE, uint64(T0), dl), dl + 1 days));
        uint80 r = nvdaFeed.push(230e8, T0 + 1 hours);
        nvda.schedule(2e18, T0 + 4 hours);
        vm.warp(T0 + 3 hours); // settled while the change is still pending
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RELEASED, "touched before the change");
    }

    // =========================================================================================================
    // R1-M5 (contract side): relayed no-ops revert, so the relayer's simulation refuses them.
    // =========================================================================================================
    function test_R1_M5_RelayedNoOpsAreUnbounded() public {
        uint256 id = _create(_params(_referee(referee), recipientEoa, address(0), 1e6, uint64(T0 + 30 days)));
        uint256 ok;
        for (uint256 i; i < 20; ++i) {
            uint256 n = escrow.nonces(recipientEoa);
            bytes memory sig = _sig(recipientPk, escrow.hashDecision(id, 1, n, block.timestamp + 1 hours));
            vm.prank(attacker); // any relayer
            try escrow.decideBySig(id, recipientEoa, 1, block.timestamp + 1 hours, sig) {
                ++ok;
            } catch {}
        }
        for (uint256 i; i < 20; ++i) {
            uint256 n = escrow.nonces(sender);
            bytes memory sig =
                _sig(senderPk, escrow.hashRefundRedirect(id, sender, address(0), n, block.timestamp + 1 hours));
            vm.prank(attacker);
            try escrow.setRefundAddressesBySig(id, sender, address(0), block.timestamp + 1 hours, sig) {
                ++ok;
            } catch {}
        }
        assertTrue(_status(id) == Status.OPEN, "nothing changed");
        assertTrue(ok <= 2, "40 relayed no-op transactions all succeeded (each one is relayer-paid gas)");
    }

    /// @notice The exact errors, and that real changes still go through (and a reverted no-op burns no nonce).
    function test_R1_M5_NoOpRevertsNoChange_RealChangesStillWork() public {
        uint256 id = _create(_params(_parties(), recipientEoa, address(0), 1e6, uint64(T0 + 30 days)));
        vm.prank(recipientEoa);
        escrow.approve(id); // first OK: recorded
        vm.prank(recipientEoa);
        vm.expectRevert(IIfsoEscrow.NoChange.selector);
        escrow.approve(id); // repeat
        uint256 n = escrow.nonces(recipientEoa);
        bytes memory sig = _sig(recipientPk, escrow.hashDecision(id, 1, n, block.timestamp + 1 hours));
        vm.expectRevert(IIfsoEscrow.NoChange.selector);
        escrow.decideBySig(id, recipientEoa, 1, block.timestamp + 1 hours, sig);
        assertEq(escrow.nonces(recipientEoa), n, "a reverted no-op leaves the nonce");

        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.NoChange.selector);
        escrow.setRefundAddresses(id, sender, address(0)); // already the refund address
        vm.prank(sender);
        escrow.setRefundAddresses(id, sender, alt); // a real change
        vm.prank(sender);
        escrow.approve(id); // second party OK: releases (PARTIES)
        assertTrue(_status(id) == Status.RELEASED, "both OKs release");
    }

    // =========================================================================================================
    // R1-M4: a frozen refund address on one side must never lock the other side's stake on VOID.
    // =========================================================================================================
    function _voidable(uint96 amt, uint96 counter) internal returns (uint256 id) {
        CreateParams memory p = _params(_referee(referee), recipient, address(0), amt, uint64(T0 + 10 days));
        p.twoSided = true;
        p.counterAmount = counter;
        p.acceptBy = uint64(T0 + 1 days);
        id = _create(p);
        vm.prank(recipient);
        escrow.accept(id, "", address(0));
    }

    function test_R1_M4_SenderFrozenRefundLocksAcceptorStakeOnVoid() public {
        address frozenA = address(0xF0F0);
        address frozenB = address(0xF1F1);
        usdg.setBlocked(frozenA, true); // e.g. sanctioned addresses already frozen by the issuer
        usdg.setBlocked(frozenB, true);
        uint256 id = _voidable(20e6, 500e6);
        vm.prank(sender);
        escrow.setRefundAddresses(id, frozenA, frozenB); // spite / ransom
        vm.warp(T0 + 10 days); // referee silent: expiry => VOID, each side should get its own stake back
        uint256 rb = usdg.balanceOf(recipient);
        bool[2] memory f = [false, true];
        for (uint256 i; i < 2; ++i) {
            for (uint256 j; j < 2; ++j) {
                try escrow.refund(id, f[i], f[j]) {} catch {}
            }
        }
        assertEq(
            usdg.balanceOf(recipient) - rb,
            500e6,
            "acceptor's own stake is locked by the sender's frozen refund addresses"
        );
    }

    /// @notice The owed side stays claimable: the sender redirects (its own money only) and anyone pays it out once.
    function test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() public {
        address frozen = address(0xF0F0);
        usdg.setBlocked(frozen, true);
        uint256 id = _voidable(20e6, 500e6);
        vm.prank(sender);
        escrow.setRefundAddresses(id, frozen, address(0));
        vm.warp(T0 + 10 days);
        uint256 rb = usdg.balanceOf(recipient);
        vm.prank(attacker);
        escrow.refund(id, false, false);
        IIfsoEscrow.Escrow memory e = escrow.getEscrow(id);
        assertTrue(e.status == Status.VOIDED, "voided");
        assertEq(e.flags & F_SENDER_OWED, F_SENDER_OWED, "sender side owed");
        assertEq(e.flags & F_COUNTER_OWED, 0, "acceptor side paid");
        assertEq(usdg.balanceOf(recipient) - rb, 500e6, "acceptor paid in the same call");
        assertEq(usdg.balanceOf(address(escrow)), 20e6, "exactly the owed side stays");

        vm.expectRevert(IIfsoEscrow.NotOpen.selector);
        escrow.claimVoid(id, true, false); // acceptor side is not owed: no double pay
        vm.expectRevert(); // still frozen
        escrow.claimVoid(id, false, false);
        vm.prank(attacker);
        vm.expectRevert(IIfsoEscrow.NotAuthorized.selector);
        escrow.setRefundAddresses(id, attacker, address(0)); // only the sender redirects
        vm.prank(sender);
        escrow.setRefundAddresses(id, alt, address(0));
        uint256 ab = usdg.balanceOf(alt);
        vm.prank(attacker); // anyone can push it out, only to the sender's own destination
        escrow.claimVoid(id, false, false);
        assertEq(usdg.balanceOf(alt) - ab, 20e6, "sender side paid to its new address");
        assertEq(usdg.balanceOf(address(escrow)), 0, "nothing left");
        vm.expectRevert(IIfsoEscrow.NotOpen.selector);
        escrow.claimVoid(id, false, false); // once only
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.NotOpen.selector);
        escrow.setRefundAddresses(id, sender, address(0)); // nothing owed any more: closed again
    }

    /// @notice Symmetric: a frozen acceptor destination never blocks the sender, and the acceptor can still exit.
    function test_R1_M4_OwedCounterSide_SenderPaid_AcceptorClaimsAlt() public {
        address frozen = address(0xF2F2);
        usdg.setBlocked(frozen, true);
        uint256 id = _voidable(20e6, 500e6);
        vm.prank(recipient);
        escrow.setCounterRefundTo(id, frozen);
        vm.warp(T0 + 10 days);
        uint256 sb = usdg.balanceOf(sender);
        escrow.refund(id, false, false);
        assertEq(usdg.balanceOf(sender) - sb, 20e6, "sender paid");
        assertEq(escrow.getEscrow(id).flags & F_COUNTER_OWED, F_COUNTER_OWED, "acceptor side owed");
        uint256 rb = usdg.balanceOf(recipient);
        escrow.claimVoid(id, true, true); // alt = the acceptor address itself
        assertEq(usdg.balanceOf(recipient) - rb, 500e6, "acceptor paid");
    }

    /// @notice S-3 on the fix: a caller cannot starve the transfer of gas (63/64 rule) to push a payable side into
    ///         the owed state. At every gas limit the refund either reverts or pays both sides.
    function test_R1_M4_GasStarvedRefundNeverMarksAPayableSideOwed() public {
        uint256 id = _voidable(20e6, 500e6);
        vm.warp(T0 + 10 days);
        uint256 paid;
        for (uint256 g = 20_000; g < 250_000; g += 1_500) {
            uint256 snap = vm.snapshotState();
            try escrow.refund{gas: g}(id, false, false) {
                assertEq(escrow.getEscrow(id).flags & (F_SENDER_OWED | F_COUNTER_OWED), 0, "payable side marked owed");
                ++paid;
            } catch {}
            vm.revertToState(snap);
        }
        assertGt(paid, 0, "some gas limit pays out");
    }

    /// @notice Kills the guard mutant: with a token whose transfer is expensive, a starved refund could otherwise
    ///         let the first transfer run out of gas, mark that side owed, and still finish. The guard reverts.
    function test_R1_M4_OutOfGasInsideTransferReverts_NotOwed() public {
        HungryUSDG h = new HungryUSDG();
        IfsoEscrow esc = new IfsoEscrow(
            owner, IUSDG(address(h)), IIfsoConditionEvaluator(address(evaluator)), address(router), 0, 0
        );
        h.mint(sender, 1_000e6);
        h.mint(recipient, 1_000e6);
        vm.prank(sender);
        h.approve(address(esc), type(uint256).max);
        vm.prank(recipient);
        h.approve(address(esc), type(uint256).max);
        CreateParams memory p = _params(_referee(referee), recipient, address(0), 20e6, uint64(T0 + 10 days));
        p.twoSided = true;
        p.counterAmount = 500e6;
        p.acceptBy = uint64(T0 + 1 days);
        vm.prank(sender);
        uint256 id = esc.create(p);
        vm.prank(recipient);
        esc.accept(id, "", address(0));
        h.setHungry(sender); // the sender side's transfer is the expensive one
        vm.warp(T0 + 10 days);
        uint256 paid;
        for (uint256 g = 2_000_000; g < 6_000_000; g += 40_000) {
            uint256 snap = vm.snapshotState();
            try esc.refund{gas: g}(id, false, false) {
                assertEq(esc.getEscrow(id).flags & (F_SENDER_OWED | F_COUNTER_OWED), 0, "starved side marked owed");
                ++paid;
            } catch {}
            vm.revertToState(snap);
        }
        assertGt(paid, 0, "enough gas pays both sides");
    }
}
