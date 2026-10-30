// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, IAggregatorProxy} from "./ForkBase.sol";
import {IfsoConditionEvaluator} from "../../src/IfsoConditionEvaluator.sol";
import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";
import {
    Condition,
    CreateParams,
    Status,
    Verdict,
    PRICE_AT_DEADLINE,
    PRICE_TOUCH,
    OP_GTE,
    OP_LTE
} from "../../src/libraries/IfsoTypes.sol";

/// @notice R4-R6: real Chainlink feed rounds on 4663 drive the AT_DEADLINE and TOUCH proofs end to end.
contract ForkFeedsTest is ForkBase {
    uint80 internal constant BACK = 3; // rounds before the latest one: prev = latest-4, r = latest-3, next = latest-2

    // ================================================================ R4: AT_DEADLINE per seed feed
    function testFork_AtDeadline_ETH() public {
        _atDeadline(FEED_ETH, address(0));
    }

    function testFork_AtDeadline_SPY() public {
        _atDeadline(FEED_SPY, TOKEN_SPY);
    }

    function testFork_AtDeadline_NVDA() public {
        _atDeadline(FEED_NVDA, TOKEN_NVDA);
    }

    function testFork_AtDeadline_TSLA() public {
        _atDeadline(FEED_TSLA, TOKEN_TSLA);
    }

    function testFork_AtDeadline_AAPL() public {
        _atDeadline(FEED_AAPL, TOKEN_AAPL);
    }

    /// @dev Deadline strictly between round r and round r+1. The keeper's proof is round r: it settles TRUE for a
    ///      threshold at the price and FALSE for one just above it; round r-1 (not the last before the deadline) and
    ///      round r+1 (after the deadline) are PENDING; round r+1 exists and is after the deadline.
    function _atDeadline(address feed, address token) internal {
        (Round memory prev, Round memory r, Round memory next) = _window(feed, BACK);
        uint64 deadline = uint64(r.updatedAt + (next.updatedAt - r.updatedAt) / 2);
        assertGt(next.updatedAt, deadline, "round+1 is after the deadline");
        assertGt(deadline, r.updatedAt, "round is before the deadline");
        _log(string.concat("deadline ", vm.toString(uint256(deadline)), " proof round ", vm.toString(uint256(r.id))));

        // the price the evaluator must pick: round r if fresh at the deadline, else the first print after it
        int256 px = deadline - r.updatedAt <= evaluator.MAX_STALE_CAP() ? r.answer : next.answer;
        uint256[3] memory ids = _createAtDeadline(feed, token, px, deadline);

        // non-last round and after-deadline round are PENDING (and settle refuses them)
        _expectTouchPending(ids[0], prev.id, "prev round PENDING");
        _expectTouchPending(ids[0], next.id, "round after the deadline PENDING");
        vm.expectRevert(bytes4(keccak256("ConditionPending()")));
        escrow.settle(ids[0], abi.encode(prev.id), false);

        // the keeper's proof round settles
        uint256 recBefore = usdg.balanceOf(recipient);
        assertTrue(escrow.settle(ids[0], abi.encode(r.id), false) == Verdict.TRUE, "TRUE at the price");
        assertTrue(_status(ids[0]) == Status.RELEASED, "released");
        assertEq(usdg.balanceOf(recipient) - recBefore, 10e6, "recipient paid");

        uint256 sendBefore = usdg.balanceOf(sender);
        assertTrue(escrow.settle(ids[1], abi.encode(r.id), false) == Verdict.FALSE, "FALSE above the price");
        assertTrue(_status(ids[1]) == Status.RETURNED, "returned");
        assertEq(usdg.balanceOf(sender) - sendBefore, 10e6, "comes back to the sender");

        assertTrue(escrow.settle(ids[2], abi.encode(r.id), false) == Verdict.FALSE, "FALSE below the price (LTE)");
    }

    /// @dev Creates GTE px (TRUE), GTE px+1 (FALSE) and LTE px-1 (FALSE) one hour before the deadline (warping back
    ///      on the fork; feed history is plain storage), then returns to the fork's own time.
    function _createAtDeadline(address feed, address token, int256 px, uint64 deadline)
        internal
        returns (uint256[3] memory ids)
    {
        vm.warp(deadline - 1 hours);
        uint64 expiry = uint64(_max(forkNow + 1 days, uint256(deadline) + evaluator.HOLD_CAP() + 7 hours));
        ids[0] =
            _createFunded(_named(_priceCondition(feed, token, PRICE_AT_DEADLINE, OP_GTE, px, deadline), 10e6, expiry));
        ids[1] = _createFunded(
            _named(_priceCondition(feed, token, PRICE_AT_DEADLINE, OP_GTE, px + 1, deadline), 10e6, expiry)
        );
        ids[2] = _createFunded(
            _named(_priceCondition(feed, token, PRICE_AT_DEADLINE, OP_LTE, px - 1, deadline), 10e6, expiry)
        );
        vm.warp(forkNow);
    }

    // ================================================================ R5: proxy / phase layout
    function testFork_PhaseLayout_SPY() public {
        _phaseLayout(FEED_SPY, AGG_SPY, TOKEN_SPY);
    }

    function testFork_PhaseLayout_TSLA() public {
        _phaseLayout(FEED_TSLA, AGG_TSLA, TOKEN_TSLA);
    }

    function testFork_PhaseLayout_AAPL() public {
        _phaseLayout(FEED_AAPL, AGG_AAPL, TOKEN_AAPL);
    }

    /// @dev Finding (2026-10-30): the SPY/TSLA/AAPL addresses that report phase-0 round ids (191, 1819, 847) are
    ///      the DualAggregator contracts ("DualAggregator 1.0.0") BEHIND the real Chainlink proxies, not the feeds.
    ///      The proxies (phase 1) wrap them: same answers and timestamps, round id = 1<<64 | n. Proven below:
    ///      1. layout: proxy.phaseId() == 1, proxy.aggregator() == old address, identical latest round data;
    ///      2. the evaluator's proof is correct on BOTH id spaces (phase 0 on the aggregator, phase 1 on the proxy):
    ///         round r settles, round r-1 is PENDING, round r+1 is the next round in the same phase;
    ///      3. the id spaces do not mix: a proxy round id proven against the aggregator is BadProof.
    ///      Why the proxies are registered (Deploy.s.sol, app config): when Chainlink upgrades a feed it points the
    ///      proxy at a NEW aggregator (next phase); a condition registered on the old aggregator would read a feed
    ///      that stopped updating. The evaluator itself needs no change.
    function _phaseLayout(address proxy, address agg, address token) internal {
        // 1. layout
        assertEq(uint256(IAggregatorProxy(proxy).phaseId()), 1, "proxy phase");
        assertEq(IAggregatorProxy(proxy).aggregator(), agg, "proxy wraps the old address");
        (uint80 pLatest, int256 pAns,, uint256 pUpd,) = AggregatorV3Interface(proxy).latestRoundData();
        (uint80 aLatest, int256 aAns,, uint256 aUpd,) = AggregatorV3Interface(agg).latestRoundData();
        assertEq(uint256(pLatest >> 64), 1, "proxy round id carries phase 1");
        assertEq(uint256(aLatest >> 64), 0, "aggregator round id has no phase");
        assertEq(uint256(aLatest), uint256(uint64(pLatest)), "aggregator round = proxy round without phase");
        assertEq(aAns, pAns, "same answer");
        assertEq(aUpd, pUpd, "same timestamp");

        // 2. both id spaces prove correctly
        _proveOn(proxy, token, "proxy");
        vm.prank(owner);
        evaluator.setFeed(agg, true, token);
        _proveOn(agg, token, "aggregator");

        // 3. ids from the proxy are not valid on the aggregator
        (, Round memory r,) = _window(proxy, BACK);
        Condition memory c = _priceCondition(agg, token, PRICE_AT_DEADLINE, OP_GTE, 1, uint64(r.updatedAt + 1));
        vm.expectRevert(IfsoConditionEvaluator.BadProof.selector);
        evaluator.evaluate(c, 0, abi.encode(r.id), address(this));
    }

    function _proveOn(address feed, address token, string memory what) internal {
        (Round memory prev, Round memory r, Round memory next) = _window(feed, BACK);
        uint64 deadline = uint64(r.updatedAt + (next.updatedAt - r.updatedAt) / 2);
        Condition memory c = _priceCondition(feed, token, PRICE_AT_DEADLINE, OP_GTE, 1, deadline);
        assertEq(uint256(next.id), uint256(r.id) + 1, string.concat(what, ": round+1 in the same phase"));
        assertTrue(
            evaluator.evaluate(c, 0, abi.encode(r.id), address(this)) == Verdict.TRUE, string.concat(what, ": r")
        );
        assertTrue(
            evaluator.evaluate(c, 0, abi.encode(prev.id), address(this)) == Verdict.PENDING,
            string.concat(what, ": r-1")
        );
        // a round id past the latest one is rejected, not mistaken for data
        (uint80 latest,,,,) = AggregatorV3Interface(feed).latestRoundData();
        vm.expectRevert(IfsoConditionEvaluator.BadProof.selector);
        evaluator.evaluate(c, 0, abi.encode(latest + 1), address(this));
    }

    // ================================================================ R6: TOUCH on a real window
    function testFork_Touch_NVDA() public {
        (Round memory prev, Round memory r, Round memory next) = _window(FEED_NVDA, BACK);
        (uint256 id, uint256 idMiss) = _createTouch(prev, r, next);

        // rounds outside the window do not count, even if they cross
        _expectTouchPending(id, prev.id, "before window");
        _expectTouchPending(id, next.id, "after window");
        // an untouched threshold stays PENDING (refund at expiry)
        vm.expectRevert(bytes4(keccak256("ConditionPending()")));
        escrow.settle(idMiss, abi.encode(r.id), false);

        assertTrue(escrow.settle(id, abi.encode(r.id), false) == Verdict.TRUE, "crossing round settles TRUE");
        assertTrue(_status(id) == Status.RELEASED, "released");
    }

    /// @dev Window [prev+1s, midpoint(r, next)] holds round r only; threshold = r's own price (GTE crosses).
    function _createTouch(Round memory prev, Round memory r, Round memory next)
        internal
        returns (uint256 id, uint256 idMiss)
    {
        uint64 start = uint64(prev.updatedAt + 1);
        uint64 deadline = uint64(r.updatedAt + (next.updatedAt - r.updatedAt) / 2);
        vm.warp(start - 1);
        uint64 expiry = uint64(_max(forkNow + 1 days, uint256(deadline) + 7 hours));
        Condition memory c = _priceCondition(FEED_NVDA, TOKEN_NVDA, PRICE_TOUCH, OP_GTE, r.answer, deadline);
        c.start = start;
        id = _createFunded(_named(c, 10e6, expiry));
        c.threshold = _maxInt(prev.answer, _maxInt(r.answer, next.answer)) + 1; // never touched
        idMiss = _createFunded(_named(c, 10e6, expiry));
        vm.warp(forkNow);
    }

    function _expectTouchPending(uint256 id, uint80 roundId, string memory what) internal {
        Condition memory stored = escrow.getCondition(id);
        uint64 activeFrom = escrow.getEscrow(id).activeFrom;
        assertTrue(evaluator.evaluate(stored, activeFrom, abi.encode(roundId), address(this)) == Verdict.PENDING, what);
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    function _maxInt(int256 a, int256 b) internal pure returns (int256) {
        return a > b ? a : b;
    }
}
