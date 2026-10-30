// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeployBase} from "./DeployBase.sol";
import {IfsoEscrow} from "../src/IfsoEscrow.sol";
import {IfsoConditionEvaluator} from "../src/IfsoConditionEvaluator.sol";
import {IfsoOutcomeResolver} from "../src/IfsoOutcomeResolver.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {IUSDG} from "../src/interfaces/IUSDG.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {IIfsoConditionEvaluator} from "../src/interfaces/IIfsoConditionEvaluator.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockAggregator} from "../src/mocks/MockAggregator.sol";

/// @notice Deploys IFSO, wires the registry, sets the launch cap, hands every contract to the owner multisig
///         (2-step: the multisig must call acceptOwnership()), asserts the result and writes
///         `deployments/<chainid>.json`.
///
///   The script reads NO private key. The signer comes from the forge CLI:
///     forge script script/Deploy.s.sol --rpc-url <rpc> --account <keystore name> --broadcast --slow
///     (or --ledger). Robinhood Chain (4663 / 46630) additionally needs IFSO_ARMED=1 and the file
///     contracts/.armed-<chainid>; without both the script refuses before anything is signed.
///     Exception: IFSO_FORK_DRYRUN=1 against a LOCAL anvil fork of 4663 (script/fork-dryrun.sh); the node must
///     prove it is anvil, so the flag does nothing against a real RPC.
///
/// Env:
///   OWNER_MULTISIG     2-of-3 multisig that will own evaluator / resolver / router / escrow
///   PANEL_MULTISIG     outcome fallback panel multisig (separate signer set)
///   RESOLVER_CREATOR   hot key of the resolver service allowed to register questions
///   FEE_WORK / FEE_TREASURY / FEE_PERKS / FEE_BURN   fee split destinations (80/10/5/5)
///   USDG       default: RHC USDG on 4663; a fresh MockUSDG on 31337; REQUIRED on every other chain
///   PYTH       default: RHC Pyth Core on 4663, else 0 (Pyth stays off until the owner allows a price id)
///   SEQ_UPTIME_FEED   default 0 (Robinhood Chain has no sequencer uptime feed)
///   MAX_AMOUNT        launch cap per escrow side, default 1_000e6 (1,000 USDG)
///   CREATION_FEE (default 250000) · RESOLVER_FEE (default 500000) · RESOLVER_BOND (default 100e6)
///   GIT_COMMIT        commit sha recorded in the deployment file (the wrapper scripts pass it)
///   IFSO_WRITE_DEPLOYMENT   "0" skips writing the deployment file (tests)
contract Deploy is DeployBase {
    // Robinhood Chain mainnet (verified on-chain 2026-10-25; feeds and Stock Tokens re-proved on a fork 2026-10-30)
    address internal constant RHC_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant RHC_PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    // Chainlink PROXY addresses (never the aggregator behind them: an upgrade moves the proxy to a new aggregator)
    address internal constant FEED_ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant FEED_SPY = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    address internal constant FEED_NVDA = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address internal constant FEED_TSLA = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address internal constant FEED_AAPL = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;
    // ERC-8056 Stock Tokens paired with the feeds above
    address internal constant TOKEN_SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant TOKEN_NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant TOKEN_TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address internal constant TOKEN_AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;

    uint64 internal constant DISPUTE_WINDOW = 2 hours;
    uint64 internal constant PANEL_WINDOW = 72 hours;

    struct Deployed {
        IfsoConditionEvaluator evaluator;
        IfsoOutcomeResolver resolver;
        FeeRouter router;
        IfsoEscrow escrow;
        bool mockUsdg;
    }

    function _expect() internal view returns (Expect memory x) {
        x.ownerMultisig = vm.envAddress("OWNER_MULTISIG");
        x.panel = vm.envAddress("PANEL_MULTISIG");
        x.creator = vm.envAddress("RESOLVER_CREATOR");
        x.feeRecipients = [
            vm.envAddress("FEE_WORK"),
            vm.envAddress("FEE_TREASURY"),
            vm.envAddress("FEE_PERKS"),
            vm.envAddress("FEE_BURN")
        ];
        if (block.chainid == RHC_MAINNET) {
            x.usdg = vm.envOr("USDG", RHC_USDG);
            x.pyth = vm.envOr("PYTH", RHC_PYTH);
        } else if (block.chainid == 31337) {
            x.usdg = vm.envOr("USDG", address(0)); // 0 => deploy a MockUSDG
            x.pyth = vm.envOr("PYTH", address(0));
        } else {
            x.usdg = vm.envAddress("USDG");
            x.pyth = vm.envOr("PYTH", address(0));
        }
        x.seqFeed = vm.envOr("SEQ_UPTIME_FEED", address(0));
        x.creationFee = uint96(vm.envOr("CREATION_FEE", uint256(250_000)));
        x.resolverFee = uint96(vm.envOr("RESOLVER_FEE", uint256(500_000)));
        x.bond = uint96(vm.envOr("RESOLVER_BOND", uint256(100e6)));
        x.maxAmount = uint96(vm.envOr("MAX_AMOUNT", uint256(1_000e6)));
        x.disputeWindow = DISPUTE_WINDOW;
        x.panelWindow = PANEL_WINDOW;
    }

    /// @notice Deploys, wires, hands over to the multisig and asserts. See the contract header for flags and env.
    /// @return d The deployed contracts.
    function run() external returns (Deployed memory d) {
        _requireArmed(); // first statement: nothing is read or signed on a real chain before this passes
        Expect memory x = _expect();

        vm.startBroadcast();
        (, x.deployer,) = vm.readCallers();
        if (_isRealChain()) _check(x.deployer != FORGE_DEFAULT_SENDER, "no signer: pass --account or --ledger");

        if (x.usdg == address(0)) {
            x.usdg = address(new MockUSDG()); // local chain only
            d.mockUsdg = true;
        }
        (x.feeds, x.feedTokens) = _feeds();

        d.evaluator = new IfsoConditionEvaluator(x.deployer, IPyth(x.pyth), AggregatorV3Interface(x.seqFeed));
        d.resolver = new IfsoOutcomeResolver(x.deployer, x.usdg, x.disputeWindow, x.panelWindow, x.bond, x.panel);
        d.router = new FeeRouter(
            x.deployer, x.usdg, x.feeRecipients[0], x.feeRecipients[1], x.feeRecipients[2], x.feeRecipients[3]
        );
        d.escrow = new IfsoEscrow(
            x.deployer,
            IUSDG(x.usdg),
            IIfsoConditionEvaluator(address(d.evaluator)),
            address(d.router),
            x.creationFee,
            x.resolverFee
        );

        for (uint256 i; i < x.feeds.length; ++i) {
            d.evaluator.setFeed(x.feeds[i], true, x.feedTokens[i]);
        }
        d.evaluator.setResolver(address(d.resolver), true);
        d.resolver.setCreator(x.creator, true);
        d.escrow.setMaxAmount(x.maxAmount);

        d.evaluator.transferOwnership(x.ownerMultisig);
        d.resolver.transferOwnership(x.ownerMultisig);
        d.router.transferOwnership(x.ownerMultisig);
        d.escrow.transferOwnership(x.ownerMultisig);
        vm.stopBroadcast();

        _assertDeployment(d.evaluator, d.resolver, d.router, d.escrow, x);
        if (keccak256(bytes(vm.envOr("IFSO_WRITE_DEPLOYMENT", string("1")))) != keccak256("0")) _write(d, x);
    }

    /// @dev Feeds registered at deploy. Mainnet: ETH/USD + SPY, NVDA, TSLA, AAPL (each with its Stock Token).
    ///      Local: one mock feed.
    function _feeds() internal returns (address[] memory feeds, address[] memory tokens) {
        if (block.chainid == RHC_MAINNET) {
            feeds = new address[](5);
            tokens = new address[](5);
            (feeds[0], feeds[1], feeds[2], feeds[3], feeds[4]) =
            (FEED_ETH_USD, FEED_SPY, FEED_NVDA, FEED_TSLA, FEED_AAPL);
            (tokens[0], tokens[1], tokens[2], tokens[3], tokens[4]) =
            (address(0), TOKEN_SPY, TOKEN_NVDA, TOKEN_TSLA, TOKEN_AAPL);
        } else if (block.chainid == 31337) {
            feeds = new address[](1);
            tokens = new address[](1);
            feeds[0] = address(new MockAggregator("ETH / USD"));
        } else {
            address f = vm.envOr("FEED_ETH_USD", address(0));
            feeds = new address[](f == address(0) ? 0 : 1);
            tokens = new address[](feeds.length);
            if (f != address(0)) feeds[0] = f;
        }
    }

    // ------------------------------------------------------------------ deployment record
    function _write(Deployed memory d, Expect memory x) internal {
        string memory path = _deploymentPath();
        string memory json = string.concat(
            "{\n",
            _kv("chainId", vm.toString(block.chainid), false),
            _kv("commit", vm.envOr("GIT_COMMIT", string("unknown")), true),
            _kv("deployer", vm.toString(x.deployer), true),
            _kv("deployBlockAtSimulation", vm.toString(block.number), false),
            '  "contracts": {\n',
            _contracts(d, x),
            "  },\n",
            _config(x),
            '  "txs": []\n}\n'
        );
        vm.writeFile(path, json);
    }

    function _contracts(Deployed memory d, Expect memory x) internal pure returns (string memory) {
        string memory s = string.concat(
            _entry(
                "IfsoConditionEvaluator",
                address(d.evaluator),
                string.concat(_q(x.deployer), ", ", _q(x.pyth), ", ", _q(x.seqFeed)),
                false
            ),
            _entry(
                "IfsoOutcomeResolver",
                address(d.resolver),
                string.concat(
                    _q(x.deployer),
                    ", ",
                    _q(x.usdg),
                    ", ",
                    _n(x.disputeWindow),
                    ", ",
                    _n(x.panelWindow),
                    ", ",
                    _n(x.bond),
                    ", ",
                    _q(x.panel)
                ),
                false
            )
        );
        s = string.concat(
            s,
            _entry(
                "FeeRouter",
                address(d.router),
                string.concat(
                    _q(x.deployer),
                    ", ",
                    _q(x.usdg),
                    ", ",
                    _q(x.feeRecipients[0]),
                    ", ",
                    _q(x.feeRecipients[1]),
                    ", ",
                    _q(x.feeRecipients[2]),
                    ", ",
                    _q(x.feeRecipients[3])
                ),
                false
            ),
            _entry(
                "IfsoEscrow",
                address(d.escrow),
                string.concat(
                    _q(x.deployer),
                    ", ",
                    _q(x.usdg),
                    ", ",
                    _q(address(d.evaluator)),
                    ", ",
                    _q(address(d.router)),
                    ", ",
                    _n(x.creationFee),
                    ", ",
                    _n(x.resolverFee)
                ),
                !d.mockUsdg
            )
        );
        if (d.mockUsdg) s = string.concat(s, _entry("MockUSDG", x.usdg, "", true));
        return s;
    }

    function _config(Expect memory x) internal pure returns (string memory) {
        string memory feeds;
        string memory tokens;
        for (uint256 i; i < x.feeds.length; ++i) {
            feeds = string.concat(feeds, i == 0 ? "" : ", ", _q(x.feeds[i]));
            tokens = string.concat(tokens, i == 0 ? "" : ", ", _q(x.feedTokens[i]));
        }
        return string.concat(
            '  "config": {\n',
            string.concat(
                _kv2("ownerMultisig", _q(x.ownerMultisig)),
                _kv2("panelMultisig", _q(x.panel)),
                _kv2("resolverCreator", _q(x.creator)),
                _kv2("usdg", _q(x.usdg)),
                _kv2("pyth", _q(x.pyth)),
                _kv2("sequencerUptimeFeed", _q(x.seqFeed))
            ),
            string.concat(
                _kv2("feeWork", _q(x.feeRecipients[0])),
                _kv2("feeTreasury", _q(x.feeRecipients[1])),
                _kv2("feePerks", _q(x.feeRecipients[2])),
                _kv2("feeBurn", _q(x.feeRecipients[3])),
                _kv2("creationFee", _n(x.creationFee)),
                _kv2("resolverFee", _n(x.resolverFee))
            ),
            string.concat(
                _kv2("resolverBond", _n(x.bond)),
                _kv2("maxAmount", _n(x.maxAmount)),
                _kv2("disputeWindow", _n(x.disputeWindow)),
                _kv2("panelWindow", _n(x.panelWindow)),
                '    "feeds": [',
                feeds,
                "],\n",
                '    "feedStockTokens": [',
                tokens,
                "]\n"
            ),
            "  },\n"
        );
    }

    function _entry(string memory name, address a, string memory args, bool last)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '    "', name, '": { "address": ', _q(a), ', "constructorArgs": [', args, "] }", last ? "\n" : ",\n"
        );
    }

    function _kv(string memory k, string memory v, bool quoted) internal pure returns (string memory) {
        return string.concat('  "', k, '": ', quoted ? string.concat('"', v, '"') : v, ",\n");
    }

    function _kv2(string memory k, string memory v) internal pure returns (string memory) {
        return string.concat('    "', k, '": ', v, ",\n");
    }

    function _q(address a) internal pure returns (string memory) {
        return string.concat('"', vm.toString(a), '"');
    }

    function _n(uint256 v) internal pure returns (string memory) {
        return vm.toString(v);
    }
}
