// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IfsoEscrow} from "../../src/IfsoEscrow.sol";
import {IfsoConditionEvaluator} from "../../src/IfsoConditionEvaluator.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {IUSDG} from "../../src/interfaces/IUSDG.sol";
import {IPyth} from "../../src/interfaces/IPyth.sol";
import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";
import {IIfsoConditionEvaluator} from "../../src/interfaces/IIfsoConditionEvaluator.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";
import {MockStockToken} from "../../src/mocks/MockStockToken.sol";
import {
    Condition,
    CreateParams,
    Kind,
    Verdict,
    PRICE_AT_DEADLINE,
    PRICE_TOUCH,
    OP_GTE,
    OP_LTE,
    SRC_CHAINLINK,
    APPROVE_REFEREE
} from "../../src/libraries/IfsoTypes.sol";

interface HalmosVm {
    function warp(uint256 t) external;
    function prank(address a) external;
    function assume(bool c) external pure;
}

/// @notice Symbolic proofs (Halmos) of the comparison, threshold, fee and cap arithmetic. Run with
///         `halmos --root contracts --contract IfsoHalmosTest` (see tools/halmos.sh). Functions named `check_*` are
///         ignored by `forge test`; the fixture here is the real contracts, not a model of them.
contract IfsoHalmosTest {
    HalmosVm internal constant vm = HalmosVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant T0 = 1_790_000_000;
    address internal constant OWNER = address(0xA0);
    address internal constant SENDER = address(0xA2);
    address internal constant RECIPIENT = address(0xB0B);
    address internal constant REFEREE = address(0xEEF);

    MockUSDG internal usdg;
    MockAggregator internal feed;
    MockStockToken internal stock;
    IfsoConditionEvaluator internal evaluator;
    FeeRouter internal router;
    IfsoEscrow internal escrow;

    function setUp() public {
        vm.warp(T0);
        usdg = new MockUSDG();
        feed = new MockAggregator("F");
        stock = new MockStockToken();
        evaluator = new IfsoConditionEvaluator(OWNER, IPyth(address(0)), AggregatorV3Interface(address(0)));
        router = new FeeRouter(OWNER, address(usdg), address(0xF1), address(0xF2), address(0xF3), address(0xF4));
        escrow = new IfsoEscrow(
            OWNER, IUSDG(address(usdg)), IIfsoConditionEvaluator(address(evaluator)), address(router), 250_000, 500_000
        );
        vm.prank(OWNER);
        evaluator.setFeed(address(feed), true, address(stock));
    }

    // ------------------------------------------------------------------ FeeRouter split
    /// @notice The 80/10/5/5 split pays out exactly the balance for every balance: nothing is created or lost.
    function check_FeeRouterSplitConserves(uint128 total) public {
        usdg.mint(address(router), total);
        router.distribute();
        uint256 sum = usdg.balanceOf(address(0xF1)) + usdg.balanceOf(address(0xF2)) + usdg.balanceOf(address(0xF3))
            + usdg.balanceOf(address(0xF4));
        assert(sum == total);
        assert(usdg.balanceOf(address(router)) == 0);
        // dust goes to work, never to a smaller bucket
        assert(usdg.balanceOf(address(0xF1)) >= usdg.balanceOf(address(0xF2)));
        assert(usdg.balanceOf(address(0xF2)) == (uint256(total) * 1000) / 10_000);
    }

    // ------------------------------------------------------------------ fee arithmetic
    /// @notice setFees accepts exactly the values within both hard caps, and feeFor never exceeds their sum.
    function check_SetFeesBoundsAndFeeFor(uint96 creationFee, uint96 resolverFee, uint8 kindRaw) public {
        Kind kind = Kind(uint8(kindRaw % 5));
        vm.prank(OWNER);
        try escrow.setFees(creationFee, resolverFee) {
            assert(creationFee <= 5e6 && resolverFee <= 5e6);
            uint96 f = escrow.feeFor(kind);
            assert(f == (kind == Kind.OUTCOME ? creationFee + resolverFee : creationFee));
            assert(f <= 10e6);
            // the pull total is computed in uint256, so amount + fee cannot overflow for any uint96 amount
            assert(uint256(type(uint96).max) + f <= type(uint128).max);
        } catch {
            assert(creationFee > 5e6 || resolverFee > 5e6);
        }
    }

    /// @notice view == execution (contract side): for any amount, a successful create pulls exactly amount +
    ///         the fee the escrow reports, holds exactly the amount and sends exactly the fee to the router.
    ///         Holds after setFees changes too (fees are read at create time).
    function check_CreatePullsAmountPlusReportedFee(uint96 amount, uint96 creationFee) public {
        vm.assume(amount >= 1e6 && amount <= 1e15);
        vm.assume(creationFee <= 5e6);
        vm.prank(OWNER);
        escrow.setFees(creationFee, 500_000);
        usdg.mint(SENDER, 2e15);
        vm.prank(SENDER);
        usdg.approve(address(escrow), type(uint256).max);

        uint96 quoted = escrow.feeFor(Kind.TIME); // what the app's builder shows
        CreateParams memory p;
        p.amount = amount;
        p.recipient = RECIPIENT;
        p.expiry = uint64(T0 + 30 days);
        p.salt = bytes32(uint256(1));
        p.condition.kind = Kind.TIME;
        p.condition.deadline = uint64(T0 + 1 days);

        vm.prank(SENDER);
        escrow.create(p);
        assert(usdg.balanceOf(SENDER) == 2e15 - uint256(amount) - quoted);
        assert(usdg.balanceOf(address(escrow)) == amount);
        assert(usdg.balanceOf(address(router)) == quoted);
    }

    // ------------------------------------------------------------------ amount cap
    /// @notice The per-side cap is enforced on both stakes: a create succeeds only if neither stake exceeds a
    ///         non-zero cap, and setMaxAmount refuses a non-zero cap below the minimum.
    function check_CapEnforcedOnBothSides(uint96 cap, uint96 amount, uint96 counter) public {
        vm.prank(OWNER);
        try escrow.setMaxAmount(cap) {
            assert(cap == 0 || cap >= 1e6);
        } catch {
            assert(cap != 0 && cap < 1e6);
            return;
        }
        vm.assume(amount >= 1e6 && counter >= 1e6 && amount <= 1e15 && counter <= 1e15);
        usdg.mint(SENDER, 4e15);
        vm.prank(SENDER);
        usdg.approve(address(escrow), type(uint256).max);

        CreateParams memory p;
        p.amount = amount;
        p.counterAmount = counter;
        p.twoSided = true;
        p.acceptBy = uint64(T0 + 1 days);
        p.recipient = RECIPIENT;
        p.expiry = uint64(T0 + 30 days);
        p.salt = bytes32(uint256(2));
        p.condition.kind = Kind.APPROVE;
        p.condition.mode = APPROVE_REFEREE;
        p.condition.target = REFEREE;

        vm.prank(SENDER);
        try escrow.create(p) {
            assert(cap == 0 || (amount <= cap && counter <= cap));
        } catch {
            // every other field is valid, so the cap is the only possible reason to refuse
            assert(cap != 0 && (amount > cap || counter > cap));
        }
    }

    // ------------------------------------------------------------------ comparison maths
    function _atDeadline(int256 threshold, uint8 op) internal view returns (Condition memory c) {
        c.kind = Kind.PRICE;
        c.mode = PRICE_AT_DEADLINE;
        c.op = op;
        c.source = SRC_CHAINLINK;
        c.target = address(feed);
        c.stockToken = address(stock);
        c.threshold = threshold;
        c.multiplier = 1e18;
        c.deadline = uint64(T0 + 1 days);
        c.maxStale = 1 hours;
        c.holdWindow = 3 days;
    }

    /// @notice AT_DEADLINE: for every feed answer and threshold, the verdict is TRUE exactly when the comparison
    ///         holds (>= or <=) and FALSE otherwise. Boundary equality counts as met for both operators.
    function check_AtDeadlineVerdictMatchesComparison(int256 answer, int256 threshold, bool gte) public {
        vm.assume(answer > 0 && threshold > 0);
        Condition memory c = _atDeadline(threshold, gte ? OP_GTE : OP_LTE);
        uint80 r = feed.push(answer, c.deadline - 10 minutes); // fresh at the deadline
        vm.warp(c.deadline + 1);
        Verdict v = evaluator.evaluate(c, uint64(T0), abi.encode(uint256(r)), address(this));
        bool met = gte ? answer >= threshold : answer <= threshold;
        assert(v == (met ? Verdict.TRUE : Verdict.FALSE));
    }

    /// @notice TOUCH: a round inside the window decides TRUE iff it crosses; a non-crossing round stays PENDING
    ///         (a negative can never be proven, so it never returns FALSE).
    function check_TouchNeverReturnsFalse(int256 answer, int256 threshold, bool gte) public {
        vm.assume(answer > 0 && threshold > 0);
        Condition memory c = _atDeadline(threshold, gte ? OP_GTE : OP_LTE);
        c.mode = PRICE_TOUCH;
        c.maxStale = 0;
        c.holdWindow = 0;
        c.start = uint64(T0);
        uint80 r = feed.push(answer, T0 + 1 hours);
        Verdict v = evaluator.evaluate(c, uint64(T0), abi.encode(uint256(r)), address(this));
        bool met = gte ? answer >= threshold : answer <= threshold;
        assert(v == (met ? Verdict.TRUE : Verdict.PENDING));
    }

    /// @notice A stale round (older than maxStale at the deadline) never decides on its own: with no later print
    ///         yet the verdict is PENDING, never TRUE or FALSE (fail closed).
    function check_StaleRoundNeverDecides(uint32 age, int256 answer, int256 threshold) public {
        vm.assume(answer > 0 && threshold > 0);
        Condition memory c = _atDeadline(threshold, OP_GTE);
        vm.assume(age > c.maxStale && age < 3 days);
        uint80 r = feed.push(answer, c.deadline - age);
        vm.warp(c.deadline + 1);
        Verdict v = evaluator.evaluate(c, uint64(T0), abi.encode(uint256(r)), address(this));
        assert(v == Verdict.PENDING);
    }

    /// @notice A non-positive threshold or an unknown comparator can never be created.
    function check_ValidateRefusesBadThresholdAndOp(int256 threshold, uint8 op) public {
        Condition memory c = _atDeadline(threshold, op);
        try evaluator.validate(c, uint64(T0 + 30 days), 0) {
            assert(threshold > 0 && op <= OP_LTE);
        } catch {}
    }

    /// @notice R1-M1 as a proof: a challenge (acceptBy != 0) on an AT_DEADLINE price is accepted at creation only
    ///         when acceptBy + maxStale < deadline, for every acceptBy and maxStale.
    function check_R1M1_ChallengeNeedsAcceptByPlusMaxStaleBeforeDeadline(uint64 acceptBy, uint32 maxStale) public {
        Condition memory c = _atDeadline(100e8, OP_GTE);
        c.maxStale = maxStale;
        vm.assume(acceptBy != 0 && maxStale != 0 && maxStale <= 3 days);
        try evaluator.validate(c, uint64(T0 + 30 days), acceptBy) {
            assert(uint256(acceptBy) + maxStale < c.deadline);
        } catch {}
    }

    /// @notice R1-M2 as a proof: a TOUCH price is never accepted for a challenge, whatever the other fields.
    function check_R1M2_TouchNeverValidForChallenge(uint64 acceptBy, uint64 start) public {
        Condition memory c = _atDeadline(100e8, OP_GTE);
        c.mode = PRICE_TOUCH;
        c.maxStale = 0;
        c.holdWindow = 0;
        c.start = start;
        vm.assume(acceptBy != 0);
        try evaluator.validate(c, uint64(T0 + 30 days), acceptBy) {
            assert(false);
        } catch {}
    }

    /// @notice R1-L1 as a proof: a multiplier schedule that takes effect strictly after the deciding round and is
    ///         still pending at settle never VOIDs an already decided AT_DEADLINE result, whatever its value.
    function check_R1L1_PendingCorporateActionDoesNotVoid(uint256 newMultiplier, uint32 delay, int256 answer) public {
        vm.assume(answer > 0 && delay > 10 minutes + 1 && delay < 365 days);
        Condition memory c = _atDeadline(100e8, OP_GTE);
        uint256 decidedAt = c.deadline - 10 minutes;
        uint80 r = feed.push(answer, decidedAt);
        stock.schedule(newMultiplier, decidedAt + delay); // after the settle below
        vm.warp(c.deadline + 1);
        Verdict v = evaluator.evaluate(c, uint64(T0), abi.encode(uint256(r)), address(this));
        assert(v == Verdict.TRUE || v == Verdict.FALSE);
    }

    /// @notice R2-L1 as a proof, for any two corporate actions (values m1, m2 at e1 < e2; lazy or applied token;
    ///         any settle time): a TRUE/FALSE verdict implies the multiplier in force at the deciding round is the
    ///         creation snapshot. ERC-8056 shows only the latest schedule (m2, e2).
    function check_R2L1_TwoActionsDecideOnlyOnTheSnapshot(
        uint256 m1,
        uint256 m2,
        uint32 d1,
        uint32 d2,
        uint32 settleDelay,
        bool lazy
    ) public {
        vm.assume(d2 > 0);
        Condition memory c = _atDeadline(100e8, OP_GTE);
        uint256 e1 = T0 + 1 + uint256(d1);
        uint256 e2 = e1 + uint256(d2);
        uint256 nowTs = uint256(c.deadline) + 1 + uint256(settleDelay);
        uint80 r = feed.push(150e8, c.deadline - 10 minutes); // crosses: TRUE unless VOID
        uint256 shown = nowTs >= e2 && !lazy ? m2 : (nowTs >= e1 ? m1 : 1e18); // lazy lags the latest schedule
        stock.setMultiplier(shown);
        stock.schedule(m2, e2);
        vm.warp(nowTs);
        Verdict v = evaluator.evaluate(c, uint64(T0), abi.encode(uint256(r)), address(this));
        uint256 decidedAt = c.deadline - 10 minutes;
        assert(v == Verdict.VOID || (decidedAt >= e2 ? m2 : (decidedAt >= e1 ? m1 : 1e18)) == 1e18);
    }

    /// @notice A change already in force at or before the deciding round VOIDs it (the price may be re-based).
    function check_R1L1_EarlierCorporateActionVoids(uint256 newMultiplier, uint32 earlier, int256 answer) public {
        vm.assume(answer > 0 && newMultiplier != 1e18 && newMultiplier != 0);
        Condition memory c = _atDeadline(100e8, OP_GTE);
        uint256 decidedAt = c.deadline - 10 minutes;
        vm.assume(earlier < 1 days);
        uint80 r = feed.push(answer, decidedAt);
        stock.setMultiplier(newMultiplier); // already applied
        stock.schedule(newMultiplier, decidedAt - earlier);
        vm.warp(c.deadline + 1);
        Verdict v = evaluator.evaluate(c, uint64(T0), abi.encode(uint256(r)), address(this));
        assert(v == Verdict.VOID);
    }
}
