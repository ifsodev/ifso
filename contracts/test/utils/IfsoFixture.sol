// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./TestBase.sol";
import {IfsoEscrow} from "../../src/IfsoEscrow.sol";
import {IfsoConditionEvaluator} from "../../src/IfsoConditionEvaluator.sol";
import {IfsoOutcomeResolver} from "../../src/IfsoOutcomeResolver.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {IIfsoEscrow} from "../../src/interfaces/IIfsoEscrow.sol";
import {IUSDG} from "../../src/interfaces/IUSDG.sol";
import {IPyth} from "../../src/interfaces/IPyth.sol";
import {AggregatorV3Interface} from "../../src/interfaces/AggregatorV3Interface.sol";
import {IIfsoConditionEvaluator} from "../../src/interfaces/IIfsoConditionEvaluator.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {MockAggregator} from "../../src/mocks/MockAggregator.sol";
import {MockPyth} from "../../src/mocks/MockPyth.sol";
import {MockStockToken} from "../../src/mocks/MockStockToken.sol";
import {MockSequencerFeed} from "../../src/mocks/MockSequencerFeed.sol";
import {
    Condition,
    CreateParams,
    Kind,
    Status,
    PRICE_AT_DEADLINE,
    PRICE_TOUCH,
    OP_GTE,
    OP_LTE,
    SRC_CHAINLINK,
    SRC_PYTH,
    APPROVE_PARTIES,
    APPROVE_REFEREE
} from "../../src/libraries/IfsoTypes.sol";

abstract contract IfsoFixture is TestBase {
    uint256 internal constant T0 = 1_790_000_000; // 2026-09-21
    uint96 internal constant FEE = 250_000; //      0.25 USDG
    uint96 internal constant RFEE = 500_000; //     0.50 USDG
    bytes32 internal constant NVDA_PYTH_ID = keccak256("Equity.US.NVDA/USD");

    MockUSDG internal usdg;
    MockAggregator internal nvdaFeed;
    MockStockToken internal nvda;
    MockPyth internal pyth;
    MockSequencerFeed internal seq;
    IfsoConditionEvaluator internal evaluator;
    IfsoOutcomeResolver internal resolver;
    FeeRouter internal router;
    IfsoEscrow internal escrow;

    address internal owner = address(0xA0);
    address internal panel = address(0xA1);
    address internal creator = address(0xA2); // resolver question creator (studio service)
    address internal keeper = address(0xA3);
    address internal recipient = address(0xB0B);
    address internal referee = address(0xEEF);
    address internal attacker = address(0xBAD);
    address internal alt = address(0xA17);

    uint256 internal senderPk = 0xA11CE;
    address internal sender;
    uint256 internal linkPk = 0x1111C;
    address internal linkKey;
    uint256 internal recipientPk = 0xB0B0;
    address internal recipientEoa;

    uint256 internal saltCounter;

    function setUp() public virtual {
        vm.warp(T0);
        sender = vm.addr(senderPk);
        linkKey = vm.addr(linkPk);
        recipientEoa = vm.addr(recipientPk);

        usdg = new MockUSDG();
        nvdaFeed = new MockAggregator("RHNVDA / USD");
        nvda = new MockStockToken();
        pyth = new MockPyth();
        seq = new MockSequencerFeed();
        seq.set(0, T0 - 2 days);

        evaluator = new IfsoConditionEvaluator(owner, IPyth(address(pyth)), AggregatorV3Interface(address(seq)));
        router = new FeeRouter(owner, address(usdg), address(0xF1), address(0xF2), address(0xF3), address(0xF4));
        resolver = new IfsoOutcomeResolver(owner, address(usdg), 2 hours, 72 hours, 100e6, panel, address(router));
        escrow = new IfsoEscrow(
            owner, IUSDG(address(usdg)), IIfsoConditionEvaluator(address(evaluator)), address(router), FEE, RFEE
        );

        vm.startPrank(owner);
        evaluator.setFeed(address(nvdaFeed), true, address(nvda));
        evaluator.setPythId(NVDA_PYTH_ID, true, address(nvda));
        evaluator.setResolver(address(resolver), true);
        resolver.setCreator(creator, true);
        vm.stopPrank();

        usdg.mint(sender, 1_000_000e6);
        usdg.mint(recipient, 1_000_000e6);
        usdg.mint(recipientEoa, 1_000_000e6);
        usdg.mint(keeper, 1_000_000e6);
        vm.prank(sender);
        usdg.approve(address(escrow), type(uint256).max);
        vm.prank(recipient);
        usdg.approve(address(escrow), type(uint256).max);
        vm.prank(recipientEoa);
        usdg.approve(address(escrow), type(uint256).max);
        vm.prank(keeper);
        usdg.approve(address(resolver), type(uint256).max);
        vm.prank(recipient);
        usdg.approve(address(resolver), type(uint256).max);
    }

    // ------------------------------------------------------------- condition builders
    function _empty() internal pure returns (Condition memory c) {}

    function _time(uint64 at) internal pure returns (Condition memory c) {
        c.kind = Kind.TIME;
        c.deadline = at;
    }

    function _priceAt(int256 threshold, uint8 op, uint64 deadline) internal view returns (Condition memory c) {
        c.kind = Kind.PRICE;
        c.mode = PRICE_AT_DEADLINE;
        c.op = op;
        c.source = SRC_CHAINLINK;
        c.target = address(nvdaFeed);
        c.stockToken = address(nvda);
        c.threshold = threshold;
        c.multiplier = nvda.uiMultiplier();
        c.deadline = deadline;
        c.maxStale = 1 hours;
        c.holdWindow = 3 days;
    }

    function _priceTouch(int256 threshold, uint8 op, uint64 start, uint64 deadline)
        internal
        view
        returns (Condition memory c)
    {
        c.kind = Kind.PRICE;
        c.mode = PRICE_TOUCH;
        c.op = op;
        c.source = SRC_CHAINLINK;
        c.target = address(nvdaFeed);
        c.stockToken = address(nvda);
        c.threshold = threshold;
        c.multiplier = nvda.uiMultiplier();
        c.start = start;
        c.deadline = deadline;
    }

    function _parties() internal pure returns (Condition memory c) {
        c.kind = Kind.APPROVE;
        c.mode = APPROVE_PARTIES;
    }

    function _referee(address r) internal pure returns (Condition memory c) {
        c.kind = Kind.APPROVE;
        c.mode = APPROVE_REFEREE;
        c.target = r;
    }

    function _outcome(bytes32 qid, uint256 mask) internal view returns (Condition memory c) {
        c.kind = Kind.OUTCOME;
        c.target = address(resolver);
        c.key = qid;
        c.outcomeMask = mask;
    }

    // ------------------------------------------------------------- params
    function _params(Condition memory c, address to, address link, uint96 amount, uint64 expiry)
        internal
        returns (CreateParams memory p)
    {
        p.amount = amount;
        p.recipient = to;
        p.linkKey = link;
        p.expiry = expiry;
        p.salt = bytes32(++saltCounter);
        p.condition = c;
    }

    function _named(Condition memory c, uint64 expiry) internal returns (CreateParams memory) {
        return _params(c, recipient, address(0), 20e6, expiry);
    }

    function _link(Condition memory c, uint64 expiry) internal returns (CreateParams memory) {
        return _params(c, address(0), linkKey, 20e6, expiry);
    }

    function _create(CreateParams memory p) internal returns (uint256 id) {
        vm.prank(sender);
        id = escrow.create(p);
    }

    // ------------------------------------------------------------- signatures
    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _claimSig(uint256 pk, uint256 id, address to) internal view returns (bytes memory) {
        bytes32 ch = escrow.getEscrow(id).conditionHash;
        return _sig(pk, escrow.hashClaim(id, to, ch));
    }

    function _acceptSig(uint256 pk, uint256 id, address acceptor) internal view returns (bytes memory) {
        bytes32 ch = escrow.getEscrow(id).conditionHash;
        return _sig(pk, escrow.hashAccept(id, acceptor, ch));
    }

    function _usdgAuthSig(uint256 pk, address from, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(usdg.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, va, vb, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), sh));
        return _sig(pk, digest);
    }

    function _status(uint256 id) internal view returns (Status) {
        return escrow.getEscrow(id).status;
    }

    function _proof(uint80 roundId) internal pure returns (bytes memory) {
        return abi.encode(roundId);
    }
}
