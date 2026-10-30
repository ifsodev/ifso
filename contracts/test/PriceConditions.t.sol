// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./utils/IfsoFixture.sol";

contract PriceConditionsTest is IfsoFixture {
    uint64 internal dl; // deadline: a "Friday 16:00 ET"-style instant

    function setUp() public override {
        super.setUp();
        dl = uint64(T0 + 3 days);
    }

    function _openAt(int256 threshold, uint8 op) internal returns (uint256) {
        return _create(_named(_priceAt(threshold, op, dl), uint64(dl + 7 days)));
    }

    // ------------------------------------------------------------- AT_DEADLINE
    function test_AtDeadline_FreshPrice_True() public {
        uint256 id = _openAt(200e8, OP_GTE);
        nvdaFeed.push(195e8, dl - 2 hours);
        uint80 last = nvdaFeed.push(201e8, dl - 20 minutes);
        vm.warp(dl - 1);
        vm.expectRevert(IIfsoEscrow.ConditionPending.selector);
        escrow.settle(id, _proof(last), false);
        vm.warp(dl + 1);
        escrow.settle(id, _proof(last), false);
        assertTrue(_status(id) == Status.RELEASED, "released at 201 >= 200");
    }

    function test_AtDeadline_EqualityCountsForGteAndLte() public {
        uint256 a = _openAt(200e8, OP_GTE);
        uint256 b = _openAt(200e8, OP_LTE);
        uint80 r = nvdaFeed.push(200e8, dl - 5 minutes);
        vm.warp(dl + 1);
        escrow.settle(a, _proof(r), false);
        escrow.settle(b, _proof(r), false);
        assertTrue(_status(a) == Status.RELEASED && _status(b) == Status.RELEASED, "inclusive comparators");
    }

    function test_AtDeadline_False_Refunds() public {
        uint256 id = _openAt(200e8, OP_GTE);
        uint80 r = nvdaFeed.push(199e8, dl - 5 minutes);
        vm.warp(dl + 1);
        uint256 sb = usdg.balanceOf(sender);
        escrow.settle(id, _proof(r), false);
        assertEq(usdg.balanceOf(sender) - sb, 20e6, "refunded");
        assertTrue(_status(id) == Status.RETURNED, "returned");
    }

    function test_AtDeadline_NotLastRoundIsPending() public {
        uint256 id = _openAt(200e8, OP_GTE);
        uint80 early = nvdaFeed.push(250e8, dl - 2 hours);
        nvdaFeed.push(150e8, dl - 10 minutes);
        vm.warp(dl + 1);
        vm.expectRevert(IIfsoEscrow.ConditionPending.selector); // keeper cannot cherry-pick an earlier round
        escrow.settle(id, _proof(early), false);
    }

    function test_AtDeadline_RoundAfterDeadlineIsNotAProofOfTheDeadline() public {
        uint256 id = _openAt(200e8, OP_GTE);
        nvdaFeed.push(150e8, dl - 10 minutes);
        uint80 after_ = nvdaFeed.push(250e8, dl + 10 minutes);
        vm.warp(dl + 1 hours);
        vm.expectRevert(IIfsoEscrow.ConditionPending.selector);
        escrow.settle(id, _proof(after_), false);
    }

    function test_AtDeadline_OffHoursHold_UsesFirstPrintAfterDeadline() public {
        uint256 id = _openAt(200e8, OP_GTE);
        uint80 fri = nvdaFeed.push(190e8, dl - 20 hours); // stale: market closed (24/5 feed held)
        nvdaFeed.push(205e8, dl + 30 hours); //              next session's first print
        vm.warp(dl + 31 hours);
        escrow.settle(id, _proof(fri), false);
        assertTrue(_status(id) == Status.RELEASED, "decided on the first print after the deadline");
    }

    function test_AtDeadline_Stale_NoPrintYet_PendingThenVoid() public {
        uint256 id = _openAt(200e8, OP_GTE);
        uint80 r = nvdaFeed.push(210e8, dl - 20 hours);
        vm.warp(dl + 1 days);
        vm.expectRevert(IIfsoEscrow.ConditionPending.selector);
        escrow.settle(id, _proof(r), false);
        vm.warp(dl + 3 days + 1); // hold window passed with no print (feed paused, e.g. corporate action)
        uint256 sb = usdg.balanceOf(sender);
        escrow.settle(id, _proof(r), false);
        assertEq(usdg.balanceOf(sender) - sb, 20e6, "VOID -> refund");
    }

    function test_AtDeadline_Stale_NextPrintBeyondHold_Void() public {
        uint256 id = _openAt(200e8, OP_GTE);
        uint80 r = nvdaFeed.push(210e8, dl - 20 hours);
        nvdaFeed.push(250e8, dl + 3 days + 1 hours);
        vm.warp(dl + 4 days);
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RETURNED, "void refund");
    }

    function test_AtDeadline_PhaseChangeNextRound() public {
        uint256 id = _openAt(200e8, OP_GTE);
        uint80 r = nvdaFeed.push(190e8, dl - 20 hours);
        nvdaFeed.newPhase(); // aggregator upgraded behind the proxy
        nvdaFeed.push(205e8, dl + 2 hours);
        vm.warp(dl + 3 hours);
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RELEASED, "next round found in the new phase");
    }

    function test_MultiplierChange_Voids() public {
        uint256 id = _openAt(200e8, OP_GTE);
        uint80 r = nvdaFeed.push(400e8, dl - 5 minutes);
        nvda.setMultiplier(2e18); // 2:1 split mid-window
        vm.warp(dl + 1);
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RETURNED, "VOID on corporate action");
    }

    function test_SequencerDown_BlocksSettleTemporarily() public {
        uint256 id = _openAt(200e8, OP_GTE);
        uint80 r = nvdaFeed.push(201e8, dl - 5 minutes);
        vm.warp(dl + 1);
        seq.set(1, dl);
        vm.expectRevert(IfsoConditionEvaluator.SequencerDown.selector);
        escrow.settle(id, _proof(r), false);
        seq.set(0, dl + 2);
        vm.warp(dl + 2 hours);
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RELEASED, "settles after grace");
    }

    // ------------------------------------------------------------- TOUCH
    function test_Touch_InsideWindow_True() public {
        uint256 id = _create(_named(_priceTouch(200e8, OP_GTE, uint64(T0), dl), uint64(dl + 1 days)));
        vm.warp(T0 + 1 days);
        uint80 r = nvdaFeed.pushNow(203e8);
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RELEASED, "touched");
    }

    function test_Touch_RoundBeforeCreationOrNotCrossing_Pending() public {
        uint80 old = nvdaFeed.push(250e8, T0 - 1 hours);
        uint256 id = _create(_named(_priceTouch(200e8, OP_GTE, uint64(T0 - 2 hours), dl), uint64(dl + 1 days)));
        vm.expectRevert(IIfsoEscrow.ConditionPending.selector); // window never starts before creation
        escrow.settle(id, _proof(old), false);
        vm.warp(T0 + 1 hours);
        uint80 low = nvdaFeed.pushNow(150e8);
        vm.expectRevert(IIfsoEscrow.ConditionPending.selector);
        escrow.settle(id, _proof(low), false);
        // untouched -> refund at expiry
        vm.warp(dl + 1 days);
        escrow.refund(id, false, false);
        assertTrue(_status(id) == Status.RETURNED, "refund at expiry");
    }

    function test_Touch_Below_Lte() public {
        uint256 id = _create(_named(_priceTouch(150e8, OP_LTE, uint64(T0), dl), uint64(dl + 1 days)));
        vm.warp(T0 + 2 hours);
        uint80 r = nvdaFeed.pushNow(149e8);
        escrow.settle(id, _proof(r), false);
        assertTrue(_status(id) == Status.RELEASED, "touched below");
    }

    // ------------------------------------------------------------- validation
    function test_Validate_RegistryPairingAndMultiplier() public {
        Condition memory c = _priceAt(200e8, OP_GTE, dl);
        c.stockToken = address(0x1234); // creator tries to pair the feed with a different token
        CreateParams memory p = _named(c, uint64(dl + 7 days));
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);

        c = _priceAt(200e8, OP_GTE, dl);
        c.multiplier = 2e18;
        p = _named(c, uint64(dl + 7 days));
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.MultiplierMismatch.selector);
        escrow.create(p);

        MockAggregator fake = new MockAggregator("FAKE NVDA");
        c = _priceAt(200e8, OP_GTE, dl);
        c.target = address(fake);
        p = _named(c, uint64(dl + 7 days));
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.SourceNotAllowed.selector);
        escrow.create(p);
    }

    function test_Validate_ScheduledSplitBeforeDeadlineRejected() public {
        nvda.schedule(3e18, dl - 1 hours);
        CreateParams memory p = _named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 7 days));
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.MultiplierMismatch.selector);
        escrow.create(p);
    }

    function test_Validate_ExpiryMustCoverHoldWindow() public {
        CreateParams memory p = _named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 1 days)); // hold is 3 days
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);
    }

    // ------------------------------------------------------------- Pyth adapter
    function _pythCond(uint8 mode) internal view returns (Condition memory c) {
        c.kind = Kind.PRICE;
        c.mode = mode;
        c.op = OP_GTE;
        c.source = SRC_PYTH;
        c.key = NVDA_PYTH_ID;
        c.stockToken = address(nvda);
        c.multiplier = 1e18;
        c.threshold = 200e8;
        c.deadline = dl;
        if (mode == PRICE_AT_DEADLINE) {
            c.maxStale = 1 hours;
            c.holdWindow = 3 days;
        } else {
            c.start = uint64(T0);
        }
    }

    function test_Pyth_AtDeadline_FirstUpdateAfterDeadline_AndFeeRefund() public {
        uint256 id = _create(_named(_pythCond(PRICE_AT_DEADLINE), uint64(dl + 7 days)));
        bytes[] memory upd = new bytes[](1);
        // price 20150000 with expo -5 = 201.50 ; prev publish before the deadline => unique "first after"
        upd[0] = pyth.encode(NVDA_PYTH_ID, 20_150_000, 10_000, -5, dl + 1, dl - 1);
        vm.warp(dl + 10);
        vm.deal(keeper, 1 ether);
        uint256 kb = keeper.balance;
        vm.prank(keeper);
        escrow.settle{value: 100}(id, abi.encode(upd), false);
        assertTrue(_status(id) == Status.RELEASED, "pyth at-deadline");
        assertEq(kb - keeper.balance, 1, "only the update fee is kept, rest refunded");
    }

    function test_Pyth_WideConfidenceRejected() public {
        uint256 id = _create(_named(_pythCond(PRICE_AT_DEADLINE), uint64(dl + 7 days)));
        bytes[] memory upd = new bytes[](1);
        upd[0] = pyth.encode(NVDA_PYTH_ID, 20_150_000, 1_000_000, -5, dl + 1, dl - 1); // conf ~5%
        vm.warp(dl + 10);
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        vm.expectRevert(IfsoConditionEvaluator.BadProof.selector);
        escrow.settle{value: 1}(id, abi.encode(upd), false);
    }

    function test_Pyth_Touch() public {
        uint256 id = _create(_named(_pythCond(PRICE_TOUCH), uint64(dl + 1 days)));
        bytes[] memory upd = new bytes[](1);
        upd[0] = pyth.encode(NVDA_PYTH_ID, 2_010_000_000, 100_000, -7, uint64(T0 + 1 hours), uint64(T0 + 1 hours - 1));
        vm.warp(T0 + 2 hours);
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        escrow.settle{value: 1}(id, abi.encode(upd), false);
        assertTrue(_status(id) == Status.RELEASED, "pyth touch (expo -7 normalized)");
    }
}
