// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    Condition,
    Verdict,
    Kind,
    PRICE_AT_DEADLINE,
    PRICE_TOUCH,
    OP_GTE,
    OP_LTE,
    SRC_CHAINLINK,
    SRC_PYTH,
    APPROVE_PARTIES,
    APPROVE_REFEREE
} from "./libraries/IfsoTypes.sol";
import {IIfsoConditionEvaluator} from "./interfaces/IIfsoConditionEvaluator.sol";
import {IIfsoOutcomeResolver} from "./interfaces/IIfsoOutcomeResolver.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {IPyth, PythStructs} from "./interfaces/IPyth.sol";
import {IERC8056} from "./interfaces/IERC8056.sol";
import {Owned2Step} from "./utils/Owned2Step.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title  IfsoConditionEvaluator
/// @notice Single typed-condition evaluator for IFSO escrows. Stateless with respect to escrows: it only
///         reads oracles / the outcome resolver. The owner (brand multisig) curates which feeds, Pyth ids
///         and resolvers NEW escrows may reference; evaluation of existing escrows never consults the
///         registry, so curation cannot strand or redirect funds.
///
///         PRICE semantics (documented for users):
///         - AT_DEADLINE: the price in force at the deadline = the last feed round with updatedAt <= deadline,
///           if it is at most `maxStale` old at the deadline. If it is older (market closed: equity feeds are
///           24/5 and hold the last price), the FIRST print after the deadline is used, if it arrives within
///           `holdWindow` ("off-hours hold"). No print within the hold window => VOID (refund).
///         - TOUCH: TRUE as soon as any round inside [max(start, activeFrom), deadline] crosses the threshold
///           (activeFrom = creation, or acceptance for challenges).
///           A negative cannot be proven on-chain, so an untouched TOUCH condition simply stays PENDING and
///           the escrow refunds at expiry (UI sets expiry = deadline + a short grace).
///         - Any change of the Stock Token's uiMultiplier vs the creation snapshot => VOID. The feed already
///           embeds the multiplier; the contract never applies it again.
contract IfsoConditionEvaluator is IIfsoConditionEvaluator, Owned2Step {
    using SafeTransferLib for address;

    // ------------------------------------------------------------------ errors
    error InvalidCondition();
    error SourceNotAllowed();
    error MultiplierMismatch();
    error BadProof();
    error InsufficientFee();
    error SequencerDown();
    error UnprovableRound();
    error NotEvaluable();

    // ------------------------------------------------------------------ events
    event FeedSet(address indexed feed, bool allowed, address stockToken);
    event PythIdSet(bytes32 indexed priceId, bool allowed, address stockToken);
    event ResolverSet(address indexed resolver, bool allowed);

    // ------------------------------------------------------------------ constants
    uint256 public constant SEQUENCER_GRACE = 1 hours;
    uint256 public constant MAX_PYTH_CONF_BPS = 200; // reject prints whose confidence band is > 2% of price
    uint32 public constant MAX_STALE_CAP = 3 days;
    uint32 public constant HOLD_CAP = 4 days;
    uint64 public constant MAX_HORIZON = 400 days;
    uint64 public constant MIN_SETTLE_WINDOW = 6 hours; // expiry must leave keepers this long after resolution
    uint64 public constant MIN_CLAIM_WINDOW = 1 days; //  TIME: expiry >= deadline + 1 day

    // ------------------------------------------------------------------ immutables / registry
    IPyth public immutable pyth; //                                  may be address(0) (Pyth disabled)
    AggregatorV3Interface public immutable sequencerUptimeFeed; //   may be address(0) (U: RHC uptime feed address)

    mapping(address => bool) public feedAllowed;
    mapping(address => address) public feedStockToken;
    mapping(bytes32 => bool) public pythIdAllowed;
    mapping(bytes32 => address) public pythStockToken;
    mapping(address => bool) public resolverAllowed;

    constructor(address owner_, IPyth pyth_, AggregatorV3Interface sequencerUptimeFeed_) Owned2Step(owner_) {
        pyth = pyth_;
        sequencerUptimeFeed = sequencerUptimeFeed_;
    }

    // ------------------------------------------------------------------ registry admin (new escrows only)
    /// @notice Allows or removes a Chainlink feed for NEW escrows and pairs it with its Stock Token.
    /// @param feed Chainlink AggregatorV3 proxy address.
    /// @param allowed true allows it for NEW escrows, false stops new escrows from using it (existing ones are unaffected).
    /// @param stockToken ERC-8056 Stock Token paired with the feed (0 for crypto feeds).
    function setFeed(address feed, bool allowed, address stockToken) external onlyOwner {
        feedAllowed[feed] = allowed;
        feedStockToken[feed] = stockToken;
        emit FeedSet(feed, allowed, stockToken);
    }

    /// @notice Allows or removes a Pyth price id for NEW escrows and pairs it with its Stock Token.
    /// @param priceId Pyth price id.
    /// @param allowed true allows it for NEW escrows, false stops new escrows from using it (existing ones are unaffected).
    /// @param stockToken ERC-8056 Stock Token paired with the feed (0 for crypto feeds).
    function setPythId(bytes32 priceId, bool allowed, address stockToken) external onlyOwner {
        pythIdAllowed[priceId] = allowed;
        pythStockToken[priceId] = stockToken;
        emit PythIdSet(priceId, allowed, stockToken);
    }

    /// @notice Allows or removes an outcome resolver for NEW escrows.
    /// @param resolver Outcome resolver contract.
    /// @param allowed true allows it for NEW escrows, false stops new escrows from using it (existing ones are unaffected).
    function setResolver(address resolver, bool allowed) external onlyOwner {
        resolverAllowed[resolver] = allowed;
        emit ResolverSet(resolver, allowed);
    }

    // ------------------------------------------------------------------ validation
    /// @inheritdoc IIfsoConditionEvaluator
    function validate(Condition calldata c, uint64 expiry, uint64 acceptBy) external view {
        uint64 nowTs = uint64(block.timestamp);
        if (c.kind == Kind.TIME) {
            _requireZeroPrice(c);
            if (c.mode != 0 || c.target != address(0) || c.key != bytes32(0) || c.outcomeMask != 0) {
                revert InvalidCondition();
            }
            if (c.deadline <= nowTs || c.deadline > nowTs + MAX_HORIZON) revert InvalidCondition();
            if (expiry < c.deadline + MIN_CLAIM_WINDOW) revert InvalidCondition();
        } else if (c.kind == Kind.PRICE) {
            _validatePrice(c, nowTs, expiry);
            // Challenges (acceptBy != 0) must not be acceptable once the deciding price can be known:
            // - TOUCH is refused (R1-M2): it can never end FALSE, and an invitee could accept after a cross.
            // - AT_DEADLINE (R1-M1): acceptBy + maxStale < deadline. The deciding round is either the last round
            //   at/before the deadline that is at most maxStale old (so updatedAt >= deadline - maxStale >
            //   acceptBy) or the first print after the deadline (> deadline > acceptBy). Either way it is
            //   written strictly after the last moment anyone can accept, also when the market is closed.
            if (acceptBy != 0 && (c.mode == PRICE_TOUCH || uint256(acceptBy) + c.maxStale >= c.deadline)) {
                revert InvalidCondition();
            }
        } else if (c.kind == Kind.APPROVE) {
            _requireZeroPrice(c);
            if (c.key != bytes32(0) || c.outcomeMask != 0 || c.deadline != 0) revert InvalidCondition();
            if (c.mode == APPROVE_PARTIES) {
                if (c.target != address(0)) revert InvalidCondition();
            } else if (c.mode == APPROVE_REFEREE) {
                if (c.target == address(0)) revert InvalidCondition();
            } else {
                revert InvalidCondition();
            }
        } else if (c.kind == Kind.OUTCOME) {
            _requireZeroPrice(c);
            if (c.mode != 0 || c.deadline != 0) revert InvalidCondition();
            if (!resolverAllowed[c.target]) revert SourceNotAllowed();
            IIfsoOutcomeResolver r = IIfsoOutcomeResolver(c.target);
            (IIfsoOutcomeResolver.State st, uint8 n, uint64 closeTime, uint64 earliest) = r.questionInfo(c.key);
            if (st != IIfsoOutcomeResolver.State.OPEN) revert InvalidCondition();
            if (acceptBy != 0 && (acceptBy > closeTime || nowTs >= closeTime)) revert InvalidCondition();
            // bit 0 (VOID) can never count as met; no bits above numOutcomes
            if (c.outcomeMask == 0 || c.outcomeMask & 1 != 0 || (c.outcomeMask >> (uint256(n) + 1)) != 0) {
                revert InvalidCondition();
            }
            // R1-M3: room for a proposal at earliestResolve, a dispute, the full panel window and a settle margin,
            // so a losing side cannot dispute once and wait for the escrow to expire into a VOID
            if (uint256(expiry) < uint256(earliest) + r.disputeWindow() + r.panelWindow() + MIN_CLAIM_WINDOW) {
                revert InvalidCondition();
            }
        } else {
            revert InvalidCondition();
        }
    }

    function _requireZeroPrice(Condition calldata c) private pure {
        if (
            c.op != 0 || c.source != 0 || c.stockToken != address(0) || c.threshold != 0 || c.multiplier != 0
                || c.start != 0 || c.maxStale != 0 || c.holdWindow != 0
        ) revert InvalidCondition();
    }

    function _validatePrice(Condition calldata c, uint64 nowTs, uint64 expiry) private view {
        if (c.mode > PRICE_TOUCH || c.op > OP_LTE || c.threshold <= 0 || c.outcomeMask != 0) {
            revert InvalidCondition();
        }
        if (c.deadline <= nowTs || c.deadline > nowTs + MAX_HORIZON) revert InvalidCondition();

        address token;
        if (c.source == SRC_CHAINLINK) {
            if (!feedAllowed[c.target] || c.key != bytes32(0)) revert SourceNotAllowed();
            token = feedStockToken[c.target];
        } else if (c.source == SRC_PYTH) {
            if (address(pyth) == address(0) || !pythIdAllowed[c.key] || c.target != address(0)) {
                revert SourceNotAllowed();
            }
            token = pythStockToken[c.key];
        } else {
            revert InvalidCondition();
        }
        // the feed <-> Stock Token pairing comes from the registry, never from the creator
        if (c.stockToken != token) revert InvalidCondition();
        if (token == address(0)) {
            if (c.multiplier != 0) revert MultiplierMismatch();
        } else {
            if (c.multiplier != IERC8056(token).uiMultiplier()) revert MultiplierMismatch();
            // refuse conditions that a scheduled corporate action would VOID before they can resolve
            uint256 at = IERC8056(token).effectiveAt();
            if (
                at != 0 && at <= uint256(c.deadline) + c.holdWindow && IERC8056(token).newUIMultiplier() != c.multiplier
            ) {
                revert MultiplierMismatch();
            }
        }

        if (c.mode == PRICE_TOUCH) {
            if (c.start >= c.deadline || c.maxStale != 0 || c.holdWindow != 0) revert InvalidCondition();
            if (expiry < c.deadline + MIN_SETTLE_WINDOW) revert InvalidCondition();
        } else {
            if (c.start != 0) revert InvalidCondition();
            if (c.maxStale == 0 || c.maxStale > MAX_STALE_CAP) revert InvalidCondition();
            if (c.holdWindow == 0 || c.holdWindow > HOLD_CAP) revert InvalidCondition();
            if (expiry < c.deadline + c.holdWindow + MIN_SETTLE_WINDOW) revert InvalidCondition();
        }
    }

    // ------------------------------------------------------------------ evaluation
    /// @inheritdoc IIfsoConditionEvaluator
    function evaluate(Condition calldata c, uint64 activeFrom, bytes calldata proof, address refundee)
        external
        payable
        returns (Verdict v)
    {
        uint256 spent;
        if (c.kind == Kind.TIME) {
            v = block.timestamp >= c.deadline ? Verdict.TRUE : Verdict.PENDING;
        } else if (c.kind == Kind.PRICE) {
            if (c.source == SRC_CHAINLINK) {
                v = _evalChainlink(c, activeFrom, proof);
            } else {
                (v, spent) = _evalPyth(c, activeFrom, proof);
            }
        } else if (c.kind == Kind.OUTCOME) {
            v = _evalOutcome(c);
        } else {
            revert NotEvaluable(); // APPROVE is resolved by the escrow's decision functions
        }
        if (msg.value > spent) refundee.safeTransferETH(msg.value - spent);
    }

    // ---------------------------------------------------------------- Chainlink
    function _evalChainlink(Condition calldata c, uint64 activeFrom, bytes calldata proof)
        private
        view
        returns (Verdict)
    {
        if (proof.length != 32) revert BadProof();
        uint80 roundId = abi.decode(proof, (uint80));
        AggregatorV3Interface feed = AggregatorV3Interface(c.target);
        (bool ok, int256 answer, uint256 updatedAt) = _round(feed, roundId);
        if (!ok) revert BadProof();

        if (c.mode == PRICE_TOUCH) {
            uint256 from = c.start > activeFrom ? c.start : activeFrom;
            if (updatedAt < from || updatedAt > c.deadline) return Verdict.PENDING; // round outside window
            if (!_crosses(c, answer)) return Verdict.PENDING;
            _checkSequencer();
            if (_multiplierChanged(c, updatedAt)) return Verdict.VOID;
            return Verdict.TRUE;
        }

        // AT_DEADLINE: strictly after the deadline so no later round can carry updatedAt <= deadline
        if (block.timestamp <= c.deadline) return Verdict.PENDING;
        if (updatedAt > c.deadline) return Verdict.PENDING; // must prove the last round at/before the deadline
        (Verdict early, int256 px, uint256 pxAt) = _deadlinePrice(c, feed, roundId, answer, updatedAt);
        if (early != Verdict.TRUE) return early; // PENDING or VOID before any price comparison
        _checkSequencer();
        if (_multiplierChanged(c, pxAt)) return Verdict.VOID;
        return _crosses(c, px) ? Verdict.TRUE : Verdict.FALSE;
    }

    /// @dev AT_DEADLINE price and its time. Returns TRUE as "price found", else the early PENDING / VOID verdict.
    function _deadlinePrice(
        Condition calldata c,
        AggregatorV3Interface feed,
        uint80 roundId,
        int256 answer,
        uint256 updatedAt
    ) private view returns (Verdict, int256, uint256) {
        (bool hasNext, int256 nextAnswer, uint256 nextUpdatedAt) = _next(feed, roundId);
        if (hasNext && nextUpdatedAt <= c.deadline) return (Verdict.PENDING, 0, 0); // not the last round before
        if (c.deadline - updatedAt <= c.maxStale) return (Verdict.TRUE, answer, updatedAt); // fresh at the deadline
        if (hasNext) {
            if (nextUpdatedAt - c.deadline > c.holdWindow) return (Verdict.VOID, 0, 0); // no print within hold
            return (Verdict.TRUE, nextAnswer, nextUpdatedAt); // off-hours hold: first print after the deadline
        }
        if (block.timestamp > uint256(c.deadline) + c.holdWindow) return (Verdict.VOID, 0, 0);
        return (Verdict.PENDING, 0, 0); // waiting for the next session's first print
    }

    function _round(AggregatorV3Interface feed, uint80 roundId)
        private
        view
        returns (bool ok, int256 answer, uint256 updatedAt)
    {
        try feed.getRoundData(roundId) returns (uint80 rid, int256 a, uint256, uint256 u, uint80 answeredIn) {
            if (rid != roundId || a <= 0 || u == 0 || answeredIn < rid) return (false, 0, 0);
            return (true, a, u);
        } catch {
            return (false, 0, 0);
        }
    }

    /// @dev Next round after `roundId`, aware of proxy phases (roundId = phaseId << 64 | aggregatorRoundId).
    function _next(AggregatorV3Interface feed, uint80 roundId) private view returns (bool, int256, uint256) {
        (bool ok, int256 a, uint256 u) = _round(feed, roundId + 1);
        if (ok) return (true, a, u);
        (uint80 latestId,,,,) = feed.latestRoundData();
        if (latestId == roundId) return (false, 0, 0);
        uint80 nextPhaseFirst = ((roundId >> 64) + 1) << 64 | 1;
        (ok, a, u) = _round(feed, nextPhaseFirst);
        if (ok) return (true, a, u);
        revert UnprovableRound(); // keeper must wait; escrow expiry still refunds
    }

    // ---------------------------------------------------------------- Pyth
    function _evalPyth(Condition calldata c, uint64 activeFrom, bytes calldata proof)
        private
        returns (Verdict, uint256 fee)
    {
        bytes[] memory updateData = abi.decode(proof, (bytes[]));
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = c.key;
        fee = pyth.getUpdateFee(updateData);
        if (msg.value < fee) revert InsufficientFee();

        PythStructs.PriceFeed[] memory feeds;
        if (c.mode == PRICE_TOUCH) {
            uint64 from = c.start > activeFrom ? c.start : activeFrom;
            feeds = pyth.parsePriceFeedUpdates{value: fee}(updateData, ids, from, c.deadline);
            int256 px = _pythTo8(feeds[0].price);
            if (!_crosses(c, px)) return (Verdict.PENDING, fee);
            _checkSequencer();
            if (_multiplierChanged(c, feeds[0].price.publishTime)) return (Verdict.VOID, fee);
            return (Verdict.TRUE, fee);
        }
        if (block.timestamp <= c.deadline) return (Verdict.PENDING, fee);
        // first update at/after the deadline, within the hold window (naturally covers off-hours)
        feeds = pyth.parsePriceFeedUpdatesUnique{value: fee}(updateData, ids, c.deadline, c.deadline + c.holdWindow);
        int256 p = _pythTo8(feeds[0].price);
        _checkSequencer();
        if (_multiplierChanged(c, feeds[0].price.publishTime)) return (Verdict.VOID, fee);
        return (_crosses(c, p) ? Verdict.TRUE : Verdict.FALSE, fee);
    }

    /// @dev Normalizes a Pyth price to 8 decimals and rejects wide confidence bands.
    function _pythTo8(PythStructs.Price memory p) private pure returns (int256) {
        if (p.price <= 0) revert BadProof();
        uint256 absPx = uint256(uint64(p.price));
        if (uint256(p.conf) * 10_000 > absPx * MAX_PYTH_CONF_BPS) revert BadProof();
        int256 px = int256(p.price);
        int32 shift = p.expo + 8;
        if (shift >= 0) {
            if (shift > 30) revert BadProof();
            return px * int256(10 ** uint32(shift));
        }
        if (shift < -30) revert BadProof();
        return px / int256(10 ** uint32(-shift));
    }

    // ---------------------------------------------------------------- outcome
    function _evalOutcome(Condition calldata c) private view returns (Verdict) {
        (IIfsoOutcomeResolver.State st, uint8 outcome) = IIfsoOutcomeResolver(c.target).outcomeOf(c.key);
        if (st == IIfsoOutcomeResolver.State.VOID) return Verdict.VOID;
        if (st != IIfsoOutcomeResolver.State.FINAL) return Verdict.PENDING;
        if (outcome == 0) return Verdict.VOID;
        return (c.outcomeMask >> outcome) & 1 == 1 ? Verdict.TRUE : Verdict.FALSE;
    }

    // ---------------------------------------------------------------- helpers
    function _crosses(Condition calldata c, int256 px) private pure returns (bool) {
        return c.op == OP_GTE ? px >= c.threshold : px <= c.threshold;
    }

    /// @dev True when the multiplier IN FORCE AT `at` (the deciding price's time) may differ from the creation
    ///      snapshot. A corporate action that takes effect after the deciding price never VOIDs an already decided
    ///      result (R1-L1). Fails closed: an unreadable multiplier, or a changed one whose timing cannot be proven
    ///      to be after `at`, counts as a change.
    function _multiplierChanged(Condition calldata c, uint256 at) private view returns (bool) {
        if (c.stockToken == address(0)) return false;
        uint256 m;
        try IERC8056(c.stockToken).uiMultiplier() returns (uint256 x) {
            m = x;
        } catch {
            return true; // cannot verify => do not decide on a possibly re-based price
        }
        uint256 eff;
        uint256 nm;
        try IERC8056(c.stockToken).effectiveAt() returns (uint256 x) {
            eff = x;
        } catch {}
        if (eff != 0) {
            try IERC8056(c.stockToken).newUIMultiplier() returns (uint256 x) {
                nm = x;
            } catch {
                return m != c.multiplier || eff <= at; // schedule unreadable: only a provably clean state passes
            }
        }
        // current value equals the snapshot: changed only if a schedule took effect at/before `at` (not yet
        // reflected by uiMultiplier) with a different value
        if (m == c.multiplier) return eff != 0 && eff <= at && nm != c.multiplier;
        // current value differs: acceptable only when it is exactly the scheduled change, effective after `at`
        return !(eff > at && nm == m);
    }

    function _checkSequencer() private view {
        if (address(sequencerUptimeFeed) == address(0)) return;
        (, int256 status, uint256 startedAt,,) = sequencerUptimeFeed.latestRoundData();
        // status 0 = up, 1 = down; require up for at least the grace period
        if (status != 0 || block.timestamp - startedAt <= SEQUENCER_GRACE) revert SequencerDown();
    }
}
