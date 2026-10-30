// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./utils/IfsoFixture.sol";
import {Verdict} from "../src/libraries/IfsoTypes.sol";

interface VmMocks {
    function mockCallRevert(address callee, bytes calldata data, bytes calldata revertData) external;
    function clearMockedCalls() external;
}

/// @dev Implementation behind `ProxyUSDG`: its transfer to one address burns ~3M gas.
contract HungryUSDGImpl is MockUSDG {
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

/// @dev Proxy-shaped USDG (R2-I1): the real USDG is a proxy, so a transfer is two call frames and an out-of-gas in
///      the inner frame hands back about 2/64 of the gas instead of 1/64.
contract ProxyUSDG {
    address internal immutable impl;

    constructor(address i) {
        impl = i;
    }

    fallback() external payable {
        address i = impl;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), i, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}

/// @notice Security review round 2: the contract findings' PoCs as regression tests. Each `test_R2_*` asserts the
///         SAFE property; the PoC ones failed on 42567c1 / e67370b and pass with the fixes.
contract ReviewR2Test is IfsoFixture {
    uint8 internal constant F_SENDER_OWED = 32; // IfsoEscrow flag bits
    uint8 internal constant F_COUNTER_OWED = 64;

    // =========================================================================================================
    // R2-L1: `_multiplierChanged` must fail closed whenever the multiplier in force at the deciding price's time
    //   cannot be proven equal to the creation snapshot, including when two or more corporate actions happen.
    // =========================================================================================================

    /// @notice The review PoC: action 1 takes effect before the deciding price, action 2 after it and before
    ///         settle. ERC-8056 shows only action 2, so the basis at the deciding price is unknown: VOID.
    function test_R2_L1_TwoCorporateActions_FirstOneForgotten() public {
        uint64 dl = uint64(T0 + 30 days);
        uint256 id = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        nvda.schedule(1.5e18, T0 + 20 days);
        vm.warp(T0 + 20 days);
        nvda.setMultiplier(1.5e18);
        uint80 r = nvdaFeed.push(225e8, dl - 10 minutes); // 150 underlying on the 1.5x basis
        nvda.schedule(1.6e18, dl + 1 hours);
        vm.warp(dl + 2 hours);
        nvda.setMultiplier(1.6e18);
        Verdict v = escrow.settle(id, _proof(r), false);
        assertTrue(v == Verdict.VOID, "the deciding price was on a different multiplier than the snapshot: must VOID");
    }

    /// @notice Same two actions, but action 2 is still pending at settle: the value in force (1.5x) is not the
    ///         snapshot, so VOID.
    function test_R2_L1_TwoActions_SecondPending_Voids() public {
        uint64 dl = uint64(T0 + 30 days);
        uint256 id = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        nvda.schedule(1.5e18, T0 + 20 days);
        vm.warp(T0 + 20 days);
        nvda.setMultiplier(1.5e18);
        uint80 r = nvdaFeed.push(225e8, dl - 10 minutes);
        nvda.schedule(1.6e18, dl + 10 days); // announced, not yet in force
        vm.warp(dl + 2 hours);
        assertTrue(escrow.settle(id, _proof(r), false) == Verdict.VOID, "1.5x in force at the deciding price");
    }

    /// @notice A single action that takes effect after the deciding price but before settle now VOIDs as well:
    ///         from one schedule it cannot be told apart from the PoC (the value it replaced is gone). Lazy and
    ///         applied tokens alike.
    function test_R2_L1_ActionInForceBeforeSettle_Voids() public {
        uint64 dl = uint64(T0 + 2 days);
        uint256 a = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        uint256 b = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        uint80 r = nvdaFeed.push(250e8, dl - 10 minutes);
        nvda.schedule(2e18, dl + 1 hours);
        vm.warp(dl + 1 hours); // effective at this exact second
        assertTrue(escrow.settle(a, _proof(r), false) == Verdict.VOID, "lazy token, change in force: VOID");
        nvda.setMultiplier(2e18);
        assertTrue(escrow.settle(b, _proof(r), false) == Verdict.VOID, "applied token, change in force: VOID");
    }

    /// @notice A change announced but still pending at settle leaves a decided result standing (settle before the
    ///         announced effectiveAt), and so does an action back to the snapshot that was in force at the price.
    function test_R2_L1_ProvablyUnchangedStillDecides() public {
        uint64 dl = uint64(T0 + 2 days);
        uint256 a = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        uint256 b = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        uint80 r = nvdaFeed.push(250e8, dl - 10 minutes);
        nvda.schedule(2e18, dl + 1 hours);
        vm.warp(dl + 1 hours - 1); // one second before it takes effect
        assertTrue(escrow.settle(a, _proof(r), false) == Verdict.TRUE, "pending change: decided result stands");

        // b: 1.0 -> 1.5 -> back to 1.0, both before the deciding price; the value in force then is the snapshot
        nvda.schedule(1.5e18, dl - 1 days);
        nvda.setMultiplier(1.5e18);
        nvda.schedule(1e18, dl - 10 minutes); // in force from the deciding round's exact second
        nvda.setMultiplier(1e18);
        assertTrue(escrow.settle(b, _proof(r), false) == Verdict.TRUE, "snapshot in force at the price");
    }

    /// @notice Schedule fields that cannot be read fail closed (they used to be read as "no schedule").
    function test_R2_L1_UnreadableSchedule_Voids() public {
        uint64 dl = uint64(T0 + 2 days);
        uint256 a = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        uint256 b = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        uint80 r = nvdaFeed.push(250e8, dl - 10 minutes);
        vm.warp(dl + 1 hours);
        VmMocks(address(vm)).mockCallRevert(address(nvda), abi.encodeWithSignature("effectiveAt()"), "");
        assertTrue(escrow.settle(a, _proof(r), false) == Verdict.VOID, "effectiveAt unreadable: VOID");
        VmMocks(address(vm)).clearMockedCalls();
        nvda.schedule(1e18, dl + 10 days);
        VmMocks(address(vm)).mockCallRevert(address(nvda), abi.encodeWithSignature("newUIMultiplier()"), "");
        assertTrue(escrow.settle(b, _proof(r), false) == Verdict.VOID, "newUIMultiplier unreadable: VOID");
    }

    /// @notice A schedule in force at the price whose new multiplier is the snapshot, on a token that reports a
    ///         different current value (inconsistent), fails closed.
    function test_R2_L1_InconsistentToken_Voids() public {
        uint64 dl = uint64(T0 + 2 days);
        uint256 id = _create(_named(_priceAt(200e8, OP_GTE, dl), uint64(dl + 3 days + 6 hours)));
        uint80 r = nvdaFeed.push(250e8, dl - 10 minutes);
        nvda.schedule(1e18, dl - 1 hours);
        nvda.setMultiplier(3e18);
        vm.warp(dl + 1 hours);
        assertTrue(escrow.settle(id, _proof(r), false) == Verdict.VOID, "uiMultiplier != newUIMultiplier: VOID");
    }

    /// @notice TOUCH: a cross before a corporate action decides while the action is pending, VOIDs once it is in
    ///         force (the settle must come first).
    function test_R2_L1_Touch_SettleBeforeTheActionTakesEffect() public {
        uint64 dl = uint64(T0 + 3 days);
        uint256 a = _create(_named(_priceTouch(200e8, OP_GTE, uint64(T0), dl), dl + 1 days));
        uint256 b = _create(_named(_priceTouch(200e8, OP_GTE, uint64(T0), dl), dl + 1 days));
        uint80 r = nvdaFeed.push(230e8, T0 + 1 hours);
        nvda.schedule(2e18, T0 + 4 hours);
        vm.warp(T0 + 3 hours);
        escrow.settle(a, _proof(r), false);
        assertTrue(_status(a) == Status.RELEASED, "touched, change still pending");
        vm.warp(T0 + 4 hours);
        nvda.setMultiplier(2e18);
        escrow.settle(b, _proof(r), false);
        assertTrue(_status(b) == Status.RETURNED, "change in force before settle: VOID");
    }

    /// @notice The general property for any two corporate actions (lazy or applied token, any timing): the
    ///         evaluator decides TRUE/FALSE only when the multiplier in force at the deciding price is the snapshot.
    function testFuzz_R2_L1_TwoActions_DecidesOnlyOnTheSnapshotBasis(
        uint64 e1,
        uint64 e2,
        uint64 settleAt,
        uint256 m1,
        uint256 m2,
        bool lazy,
        bool sameAsSnapshot
    ) public {
        uint64 dl = uint64(T0 + 30 days);
        Condition memory c = _priceAt(200e8, OP_GTE, dl);
        uint256 snap = c.multiplier;
        uint256 at = dl - 10 minutes;
        e1 = uint64(bound(e1, T0 + 1, dl + 10 days));
        e2 = uint64(bound(e2, e1 + 1, dl + 20 days));
        settleAt = uint64(bound(settleAt, dl + 1, dl + 20 days));
        m1 = bound(m1, 1, 10e18);
        m2 = sameAsSnapshot ? snap : bound(m2, 1, 10e18);
        uint80 r = nvdaFeed.push(250e8, at);

        // token state at settle: both actions announced, only the latest schedule is visible
        vm.warp(settleAt);
        uint256 applied = settleAt >= e2 ? m2 : (settleAt >= e1 ? m1 : snap);
        uint256 shown = lazy ? (settleAt >= e1 ? m1 : snap) : applied; // a lazy token lags the latest schedule
        nvda.setMultiplier(shown);
        nvda.schedule(m2, e2);
        uint256 inForceAtPrice = at >= e2 ? m2 : (at >= e1 ? m1 : snap);

        Verdict v = evaluator.evaluate(c, uint64(T0), _proof(r), address(this));
        if (v == Verdict.TRUE || v == Verdict.FALSE) assertEq(inForceAtPrice, snap, "decided on a re-based price");
    }

    // =========================================================================================================
    // R2-L2 (R1-M3 residual): an honest proposal made late (sources a day or two behind) plus a dispute must still
    //   settle before expiry. The OUTCOME expiry minimum now includes PROPOSAL_GRACE (2 days).
    // =========================================================================================================
    function test_R2_L2_LateProposal_DisputeStillRunsOutTheClock() public {
        uint64 kickoff = uint64(T0 + 1 days);
        uint64 earliest = kickoff + 150 minutes;
        vm.prank(creator);
        bytes32 qid = resolver.createQuestion(keccak256("ARS-CHE-late"), kickoff, earliest, 3, "");
        CreateParams memory p =
            _params(_outcome(qid, 1 << 1), recipient, address(0), 1_000e6, earliest + 2 hours + 72 hours + 1 days);
        p.twoSided = true;
        p.counterAmount = 1_000e6;
        p.acceptBy = kickoff - 1 hours;
        // the round-1 minimum is refused now, and so is one second under the new one
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);
        uint64 minExpiry = earliest + evaluator.PROPOSAL_GRACE() + 2 hours + 72 hours + 1 days;
        assertEq(evaluator.PROPOSAL_GRACE(), 2 days, "covers the review's 30 h late sources");
        assertTrue(minExpiry <= earliest + 7 days, "the app's earliestResolve + 7 days still fits the deployed windows");
        p.expiry = minExpiry - 1;
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);

        p.expiry = minExpiry;
        uint256 id = _create(p);
        vm.prank(recipient);
        escrow.accept(id, "", address(0));

        // worst case covered: the honest proposal comes PROPOSAL_GRACE late, the loser disputes at the last second
        // of the dispute window and the panel answers at the last second of its own
        vm.warp(earliest + evaluator.PROPOSAL_GRACE());
        vm.prank(keeper);
        resolver.propose(qid, 1, keccak256("sources"));
        usdg.mint(attacker, 100e6);
        vm.startPrank(attacker);
        usdg.approve(address(resolver), type(uint256).max);
        vm.warp(block.timestamp + 2 hours - 1);
        resolver.dispute(qid, keccak256("nonsense"));
        vm.stopPrank();
        vm.warp(block.timestamp + 72 hours - 1);
        vm.prank(panel);
        resolver.panelResolve(qid, 1);
        assertTrue(block.timestamp < minExpiry, "panel answered before expiry");
        uint256 rb = usdg.balanceOf(recipient);
        escrow.settle(id, "", false);
        assertEq(usdg.balanceOf(recipient) - rb, 2_000e6, "winner should receive the pot once the panel confirms");
    }

    // =========================================================================================================
    // R2-I1: through a proxy-shaped USDG the 63/64 guard in `_tryPay` is not what stops a starved transfer (the
    //   outer frame returns ~2/64), but the work left after the transfer cannot finish on what comes back, so a
    //   starved refund reverts as a whole and never records a payable side as owed.
    // =========================================================================================================
    function test_R2_I1_ProxyUsdg_StarvedRefundNeverMarksAPayableSideOwed() public {
        HungryUSDGImpl impl = new HungryUSDGImpl();
        HungryUSDGImpl h = HungryUSDGImpl(address(new ProxyUSDG(address(impl))));
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
        h.setHungry(sender);
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
