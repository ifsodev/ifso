// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "../utils/TestBase.sol";
import {IfsoEscrow} from "../../src/IfsoEscrow.sol";
import {IfsoConditionEvaluator} from "../../src/IfsoConditionEvaluator.sol";
import {IfsoOutcomeResolver} from "../../src/IfsoOutcomeResolver.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {IUSDG} from "../../src/interfaces/IUSDG.sol";
import {IPyth} from "../../src/interfaces/IPyth.sol";
import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";
import {IIfsoConditionEvaluator} from "../../src/interfaces/IIfsoConditionEvaluator.sol";
import {IERC8056} from "../../src/interfaces/IERC8056.sol";
import {
    Condition,
    CreateParams,
    Kind,
    Status,
    PRICE_AT_DEADLINE,
    PRICE_TOUCH,
    SRC_CHAINLINK
} from "../../src/libraries/IfsoTypes.sol";

/// @notice Chainlink proxy getters that are not in AggregatorV3Interface.
interface IAggregatorProxy {
    function phaseId() external view returns (uint16);
    function aggregator() external view returns (address);
}

/// @notice Base for fork proofs against REAL Robinhood Chain mainnet (4663) state.
///
///   RHC_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'test/fork/*' -vv
///
/// Without RHC_FORK_RPC every fork test is skipped. RHC_FORK_BLOCK pins the fork block; when it is unset the fork
/// starts at the latest block. Reason: the public RPC keeps state for only ~10 minutes (measured 2026-10-30: 4,000
/// blocks back answers, 7,000 back is "historical state not available"), so a hard-coded pin stops working minutes
/// after it is written unless Foundry's cache already holds every slot. Every proof below is therefore written to
/// hold at ANY block after the recorded one: price proofs use historical rounds chosen relative to the latest round
/// (round data never changes once written), and money paths use balances written by the test itself. The block of
/// each run is printed (-vv) and the acceptance run's block is recorded in docs/research/chain-facts.md.
abstract contract ForkBase is TestBase {
    // ------------------------------------------------------------- real addresses on 4663 (chain-facts.md)
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;

    // Chainlink PROXIES (EACAggregatorProxy, phase-aware round ids), from feeds-robinhood-mainnet.json
    address internal constant FEED_ETH = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant FEED_SPY = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address internal constant FEED_NVDA = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address internal constant FEED_TSLA = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address internal constant FEED_AAPL = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;

    // The underlying DualAggregator contracts that chain-facts.md and the old config listed as "feeds" for SPY,
    // TSLA and AAPL (they report phase-0 round ids because they are not proxies, and gate reads by access list).
    address internal constant AGG_SPY = 0x78BCB218fA04B9b3a278eBc865Ed320BF8DEFBAc;
    address internal constant AGG_TSLA = 0x7A6b81ba7FbCB90104d8C496158Cf383cD7233b1;
    address internal constant AGG_AAPL = 0xBb11A21267cFDb63d4935d99a499133DD1744ACb;

    // ERC-8056 Stock Tokens
    address internal constant TOKEN_SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant TOKEN_NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant TOKEN_TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address internal constant TOKEN_AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;

    /// @dev USDG (Paxos-style proxy) keeps `balances` at storage slot 1: keccak256(abi.encode(holder, 1)).
    ///      Found 2026-10-30 by scanning slots 0..60 for a known holder (the v4 PoolManager) with `cast index` +
    ///      `cast storage`; `_dealUsdg` re-checks it against balanceOf on every use.
    uint256 internal constant USDG_BALANCE_SLOT = 1;

    uint96 internal constant FEE = 250_000;
    uint96 internal constant RFEE = 500_000;

    IUSDG internal usdg = IUSDG(USDG);
    IfsoConditionEvaluator internal evaluator;
    IfsoOutcomeResolver internal resolver;
    FeeRouter internal router;
    IfsoEscrow internal escrow;

    address internal owner = address(0xA0);
    address internal panel = address(0xA1);
    address internal relayer = address(0xA3);
    address internal recipient = address(0xB0B);

    // Keys generated for the test (never anvil defaults: those are swept on 4663).
    uint256 internal senderPk = uint256(keccak256("ifso.fork.sender"));
    address internal sender;

    uint256 internal forkNow; // block.timestamp of the forked block
    uint256 internal saltCounter;

    function setUp() public virtual {
        string memory rpc = vm.envOr("RHC_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 pin = vm.envOr("RHC_FORK_BLOCK", uint256(0));
        if (pin == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, pin);
        assertEq(block.chainid, 4663, "fork is not Robinhood Chain mainnet");
        forkNow = block.timestamp;
        _log(string.concat("fork L2 block ", vm.toString(_l2Block(pin)), " timestamp ", vm.toString(block.timestamp)));

        sender = vm.addr(senderPk);
        evaluator = new IfsoConditionEvaluator(owner, IPyth(PYTH), AggregatorV3Interface(address(0)));
        resolver = new IfsoOutcomeResolver(owner, USDG, 2 hours, 72 hours, 100e6, panel);
        router = new FeeRouter(owner, USDG, address(0xF1), address(0xF2), address(0xF3), address(0xF4));
        escrow = new IfsoEscrow(owner, usdg, IIfsoConditionEvaluator(address(evaluator)), address(router), FEE, RFEE);

        vm.startPrank(owner);
        evaluator.setFeed(FEED_ETH, true, address(0));
        evaluator.setFeed(FEED_SPY, true, TOKEN_SPY);
        evaluator.setFeed(FEED_NVDA, true, TOKEN_NVDA);
        evaluator.setFeed(FEED_TSLA, true, TOKEN_TSLA);
        evaluator.setFeed(FEED_AAPL, true, TOKEN_AAPL);
        evaluator.setResolver(address(resolver), true);
        escrow.setMaxAmount(1_000e6);
        vm.stopPrank();
    }

    /// @dev block.number on an Arbitrum chain is the L1 block estimate. The L2 block of the fork is the pin, or
    ///      (unpinned) the RPC's head read right after the fork was created.
    function _l2Block(uint256 pin) internal returns (uint256 n) {
        if (pin != 0) return pin;
        bytes memory b = vm.rpc("eth_blockNumber", "[]");
        for (uint256 i; i < b.length; ++i) {
            n = (n << 8) | uint8(b[i]);
        }
    }

    // ------------------------------------------------------------- USDG
    /// @dev Writes a USDG balance (no supply change) and proves the slot is the real balances mapping.
    function _dealUsdg(address to, uint256 amount) internal {
        bytes32 slot = keccak256(abi.encode(to, USDG_BALANCE_SLOT));
        vm.store(USDG, slot, bytes32(amount));
        assertEq(usdg.balanceOf(to), amount, "USDG balance slot moved: re-scan it");
    }

    // ------------------------------------------------------------- feeds
    struct Round {
        uint80 id;
        int256 answer;
        uint256 updatedAt;
    }

    function _round(address feed, uint80 id) internal view returns (Round memory r) {
        (uint80 rid, int256 a,, uint256 u,) = AggregatorV3Interface(feed).getRoundData(id);
        assertEq(uint256(rid), uint256(id), "round id echo");
        assertTrue(a > 0 && u != 0, "round has no data");
        r = Round(id, a, u);
    }

    /// @dev Three consecutive historical rounds (prev, r, next) ending `back` rounds before the latest one, all in
    ///      the latest phase, with distinct timestamps so a deadline fits strictly between r and next.
    function _window(address feed, uint80 back)
        internal
        view
        returns (Round memory prev, Round memory r, Round memory next)
    {
        (uint80 latest,,,,) = AggregatorV3Interface(feed).latestRoundData();
        uint80 id = latest - back;
        assertEq(uint256(id >> 64), uint256(latest >> 64), "window crosses a phase");
        assertGt(uint256(uint64(id)), 1, "not enough rounds in this phase");
        prev = _round(feed, id - 1);
        r = _round(feed, id);
        next = _round(feed, id + 1);
        assertGt(r.updatedAt, prev.updatedAt, "rounds not increasing (prev)");
        assertGt(next.updatedAt, r.updatedAt + 1, "rounds too close for a deadline between them");
    }

    // ------------------------------------------------------------- escrow helpers
    function _priceCondition(address feed, address token, uint8 mode, uint8 op, int256 threshold, uint64 deadline)
        internal
        view
        returns (Condition memory c)
    {
        c.kind = Kind.PRICE;
        c.mode = mode;
        c.op = op;
        c.source = SRC_CHAINLINK;
        c.target = feed;
        c.stockToken = token;
        c.threshold = threshold;
        c.multiplier = token == address(0) ? 0 : IERC8056(token).uiMultiplier();
        c.deadline = deadline;
        if (mode == PRICE_AT_DEADLINE) {
            c.maxStale = evaluator.MAX_STALE_CAP();
            c.holdWindow = evaluator.HOLD_CAP();
        }
    }

    function _named(Condition memory c, uint96 amount, uint64 expiry) internal returns (CreateParams memory p) {
        p.amount = amount;
        p.recipient = recipient;
        p.expiry = expiry;
        p.salt = bytes32(++saltCounter);
        p.condition = c;
    }

    /// @dev Funds `sender`, approves and creates. Caller sets the time first.
    function _createFunded(CreateParams memory p) internal returns (uint256 id) {
        uint256 total = uint256(p.amount) + escrow.feeFor(p.condition.kind);
        _dealUsdg(sender, total);
        vm.prank(sender);
        usdg.approve(address(escrow), total);
        vm.prank(sender);
        id = escrow.create(p);
    }

    function _status(uint256 id) internal view returns (Status) {
        return escrow.getEscrow(id).status;
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------- logging (-vv), vendored console.log(string)
    function _log(string memory s) internal view {
        address c = 0x000000000000000000636F6e736F6c652e6c6f67;
        (bool ok,) = c.staticcall(abi.encodeWithSignature("log(string)", s));
        ok;
    }
}
