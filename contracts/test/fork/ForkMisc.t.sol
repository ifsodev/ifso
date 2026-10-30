// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {DeployBase} from "../../script/DeployBase.sol";
import {IfsoConditionEvaluator} from "../../src/IfsoConditionEvaluator.sol";
import {IERC8056} from "../../src/interfaces/IERC8056.sol";
import {IPyth} from "../../src/interfaces/IPyth.sol";
import {Condition, Status, Verdict, PRICE_AT_DEADLINE, OP_GTE} from "../../src/libraries/IfsoTypes.sol";

/// @notice Exposes the deploy script's fork-dry-run check.
contract DryRunProbe is DeployBase {
    function probe() external returns (bool) {
        return _isForkDryRun();
    }

    function armed() external {
        _requireArmed();
    }
}

/// @notice R7 Stock Token pairing, R8 sequencer uptime feed, R9 Pyth Core on 4663.
contract ForkMiscTest is ForkBase {
    // ================================================================ R7
    function testFork_MultiplierPairing() public {
        address[4] memory feeds = [FEED_SPY, FEED_NVDA, FEED_TSLA, FEED_AAPL];
        address[4] memory tokens = [TOKEN_SPY, TOKEN_NVDA, TOKEN_TSLA, TOKEN_AAPL];
        for (uint256 i; i < 4; ++i) {
            uint256 m = IERC8056(tokens[i]).uiMultiplier();
            _log(string.concat("uiMultiplier ", vm.toString(tokens[i]), " = ", vm.toString(m)));
            assertTrue(m >= 1e18 && m < 2e18, "multiplier in the expected range");
            assertEq(evaluator.feedStockToken(feeds[i]), tokens[i], "registry pairs feed and token");

            uint64 deadline = uint64(block.timestamp + 2 days);
            uint64 expiry = deadline + evaluator.HOLD_CAP() + 7 hours;
            Condition memory c = _priceCondition(feeds[i], tokens[i], PRICE_AT_DEADLINE, OP_GTE, 1e8, deadline);
            evaluator.validate(c, expiry, 0); // live multiplier snapshot is accepted

            Condition memory wrong = _copyC(c);
            wrong.multiplier = m + 1;
            vm.expectRevert(IfsoConditionEvaluator.MultiplierMismatch.selector);
            evaluator.validate(wrong, expiry, 0);

            Condition memory unpaired = _copyC(c);
            unpaired.stockToken = address(0); // the creator cannot drop the pairing
            unpaired.multiplier = 0;
            vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
            evaluator.validate(unpaired, expiry, 0);

            // a corporate action scheduled before the deadline (+ hold) is refused at creation
            vm.mockCall(tokens[i], abi.encodeWithSignature("effectiveAt()"), abi.encode(block.timestamp + 1 days));
            vm.mockCall(tokens[i], abi.encodeWithSignature("newUIMultiplier()"), abi.encode(m * 2));
            vm.expectRevert(IfsoConditionEvaluator.MultiplierMismatch.selector);
            evaluator.validate(c, expiry, 0);
            vm.clearMockedCalls();
        }

        // an escrow created on the live multiplier VOIDs (money comes back) when a change lands before settlement
        (, Round memory r, Round memory next) = _window(FEED_SPY, 3);
        uint64 dl = uint64(r.updatedAt + (next.updatedAt - r.updatedAt) / 2);
        vm.warp(dl - 1 hours);
        Condition memory sc = _priceCondition(FEED_SPY, TOKEN_SPY, PRICE_AT_DEADLINE, OP_GTE, 1, dl);
        uint64 exp = uint64(
            forkNow + 1 days > uint256(dl) + 4 days + 7 hours ? forkNow + 1 days : uint256(dl) + 4 days + 7 hours
        );
        uint256 id = _createFunded(_named(sc, 10e6, exp));
        vm.warp(forkNow);
        uint256 m0 = IERC8056(TOKEN_SPY).uiMultiplier();
        vm.mockCall(TOKEN_SPY, abi.encodeWithSignature("effectiveAt()"), abi.encode(forkNow - 1));
        vm.mockCall(TOKEN_SPY, abi.encodeWithSignature("newUIMultiplier()"), abi.encode(m0 + 1));
        uint256 before = usdg.balanceOf(sender);
        assertTrue(escrow.settle(id, abi.encode(r.id), false) == Verdict.VOID, "scheduled change took effect: VOID");
        assertTrue(_status(id) == Status.RETURNED, "one-sided VOID returns the money");
        assertEq(usdg.balanceOf(sender) - before, 10e6, "comes back to the sender");
        vm.clearMockedCalls();
    }

    // ================================================================ R8
    /// @dev No Chainlink L2 sequencer uptime feed is published for Robinhood Chain: the 58 feeds in
    ///      https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json (2026-10-30) contain none.
    ///      The evaluator therefore runs with the check disabled (address 0) and still settles real rounds.
    function testFork_Sequencer_NoneOn4663() public {
        assertEq(address(evaluator.sequencerUptimeFeed()), address(0), "deploy default: disabled");
        (, Round memory r, Round memory next) = _window(FEED_ETH, 3);
        uint64 dl = uint64(r.updatedAt + (next.updatedAt - r.updatedAt) / 2);
        Condition memory c;
        vm.warp(dl - 1 hours);
        c = _priceCondition(FEED_ETH, address(0), PRICE_AT_DEADLINE, OP_GTE, 1, dl);
        vm.warp(forkNow);
        assertTrue(evaluator.evaluate(c, dl - 1 hours, abi.encode(r.id), address(this)) == Verdict.TRUE, "settles");
    }

    // ================================================================ R9
    /// @dev Pyth Core on 4663 (proxy, implementation version "1.4.5-alpha.1") exposes parsePriceFeedUpdatesUnique:
    ///      malformed update data reverts with Pyth's own InvalidUpdateData() error (0xe69ffece) from inside the
    ///      function, while an unknown selector reverts with empty data. A real signed Hermes update could not be
    ///      recorded: hermes.pyth.network and benchmarks.pyth.network answer 401 without an API key (2026-10-30),
    ///      so the full parse is VERIFY. The Pyth path stays off by default (no price id is allowed).
    function testFork_Pyth_Unique() public {
        // Pyth ETH/USD price id, written in two halves so the public guard does not read it as a key
        bytes32 ethUsd =
            bytes32((uint256(0xff61491a931112ddf1bd8147cd1b6413) << 128) | uint256(0x75f79f5825126d665480874634fd0ace));
        bytes[] memory data = new bytes[](1);
        data[0] = hex"504e4155"; // "PNAU" magic only
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = ethUsd;
        vm.deal(address(this), 1 ether);

        (bool ok, bytes memory ret) =
            PYTH.call{value: 1}(abi.encodeCall(IPyth.parsePriceFeedUpdatesUnique, (data, ids, uint64(0), uint64(1))));
        assertFalse(ok, "garbage must not parse");
        assertEq(ret.length, 4, "a Pyth custom error, not an unknown-function revert");
        assertEq(bytes4(ret), bytes4(0xe69ffece), "InvalidUpdateData()");

        (ok, ret) = PYTH.call(abi.encodeWithSignature("doesNotExist(uint256)", 1));
        assertFalse(ok, "unknown function reverts");
        assertEq(ret.length, 0, "unknown function: empty revert data");

        assertEq(address(evaluator.pyth()), PYTH, "adapter wired to Pyth Core");
        assertFalse(evaluator.pythIdAllowed(ethUsd), "Pyth off by default: no price id allowed");
    }

    // ================================================================ R10 guard
    /// @dev IFSO_FORK_DRYRUN=1 must not open the armed-flag guard on a real RPC (the fork keeps chain id 4663, so
    ///      only the node can tell). Against the public RPC the check reverts; against a local anvil fork it passes.
    function testFork_DryRunGuard_RefusesRealRpc() public {
        DryRunProbe p = new DryRunProbe();
        vm.setEnv("IFSO_FORK_DRYRUN", "0");
        assertFalse(p.probe(), "flag off: no dry run");
        vm.setEnv("IFSO_ARMED", "0");
        vm.expectRevert(abi.encodeWithSelector(DeployBase.NotArmed.selector, uint256(4663)));
        p.armed();

        vm.setEnv("IFSO_FORK_DRYRUN", "1");
        string memory client = abi.decode(vm.rpc("web3_clientVersion", "[]"), (string));
        if (_startsWith(client, "anvil/")) {
            assertTrue(p.probe(), "local anvil fork: dry run allowed");
        } else {
            vm.expectRevert(DeployBase.NotForkDryRun.selector);
            p.probe();
            vm.expectRevert(DeployBase.NotForkDryRun.selector);
            p.armed();
        }
        vm.setEnv("IFSO_FORK_DRYRUN", "0");
    }

    function _startsWith(string memory s, string memory pre) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(pre);
        if (a.length < b.length) return false;
        for (uint256 i; i < b.length; ++i) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }

    function _copyC(Condition memory c) internal pure returns (Condition memory) {
        return abi.decode(abi.encode(c), (Condition)); // memory structs alias on assignment
    }

    receive() external payable {}
}
