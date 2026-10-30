// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "../test/utils/TestBase.sol";
import {IfsoEscrow} from "../src/IfsoEscrow.sol";
import {IfsoConditionEvaluator} from "../src/IfsoConditionEvaluator.sol";
import {IfsoOutcomeResolver} from "../src/IfsoOutcomeResolver.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {IUSDG} from "../src/interfaces/IUSDG.sol";
import {IPyth} from "../src/interfaces/IPyth.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {IIfsoConditionEvaluator} from "../src/interfaces/IIfsoConditionEvaluator.sol";

/// @notice Deploys IFSO to Robinhood Chain (4663) from a FRESH deployer, wires the registry, then hands every
///         contract to the brand multisig (2-step: the Safe must call acceptOwnership()).
///
///   forge script script/Deploy.s.sol --rpc-url rhc --broadcast --slow
///
/// Env:
///   DEPLOYER_PK        fresh key, funded with a little ETH (never reused across brands)
///   OWNER_SAFE         brand Safe (2-of-3) that will own evaluator / resolver / router / escrow
///   PANEL_SAFE         outcome fallback panel Safe (separate signer set)
///   RESOLVER_CREATOR   hot key of the resolver service allowed to register questions
///   FEE_WORK / FEE_TREASURY / FEE_PERKS / FEE_BURN   fee split destinations (80/10/5/5)
///   USDG (default RHC USDG) · PYTH (default RHC Pyth Core) · SEQ_UPTIME_FEED (default 0 = disabled, (U))
///   CREATION_FEE (default 250000 = 0.25 USDG) · RESOLVER_FEE (default 500000) · RESOLVER_BOND (default 100 USDG)
contract Deploy {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Robinhood Chain mainnet (verified on-chain 2026-10-25)
    address internal constant RHC_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant RHC_PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    address internal constant FEED_ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant FEED_SPY = 0x78BCB218fA04B9b3a278eBc865Ed320BF8DEFBAc;
    address internal constant TOKEN_SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    // NVDA / TSLA / AAPL feeds are known (0x379E.., 0x7A6b.., 0xBb11..); their Stock Token addresses come from
    // api.robinhood.com/rhj/assets and are registered by the Safe in a follow-up batch (see README).

    struct Config {
        uint256 pk;
        address deployer;
        address ownerSafe;
        address panelSafe;
        address creator;
        address usdg;
        address pyth;
        address seqFeed;
        uint96 creationFee;
        uint96 resolverFee;
        uint96 bond;
    }

    function _config() internal view returns (Config memory c) {
        c.pk = vm.envUint("DEPLOYER_PK");
        c.deployer = vm.addr(c.pk);
        c.ownerSafe = vm.envAddress("OWNER_SAFE");
        c.panelSafe = vm.envAddress("PANEL_SAFE");
        c.creator = vm.envAddress("RESOLVER_CREATOR");
        c.usdg = vm.envOr("USDG", RHC_USDG);
        c.pyth = vm.envOr("PYTH", RHC_PYTH);
        c.seqFeed = vm.envOr("SEQ_UPTIME_FEED", address(0));
        c.creationFee = uint96(vm.envOr("CREATION_FEE", uint256(250_000)));
        c.resolverFee = uint96(vm.envOr("RESOLVER_FEE", uint256(500_000)));
        c.bond = uint96(vm.envOr("RESOLVER_BOND", uint256(100e6)));
    }

    function run()
        external
        returns (IfsoConditionEvaluator evaluator, IfsoOutcomeResolver resolver, FeeRouter router, IfsoEscrow escrow)
    {
        Config memory c = _config();
        vm.startBroadcast(c.pk);
        evaluator = new IfsoConditionEvaluator(c.deployer, IPyth(c.pyth), AggregatorV3Interface(c.seqFeed));
        resolver = new IfsoOutcomeResolver(c.deployer, c.usdg, 2 hours, 72 hours, c.bond, c.panelSafe);
        router = _router(c);
        escrow = new IfsoEscrow(
            c.ownerSafe,
            IUSDG(c.usdg),
            IIfsoConditionEvaluator(address(evaluator)),
            address(router),
            c.creationFee,
            c.resolverFee
        );

        evaluator.setFeed(FEED_ETH_USD, true, address(0));
        if (block.chainid == 4663) evaluator.setFeed(FEED_SPY, true, TOKEN_SPY);
        evaluator.setResolver(address(resolver), true);
        resolver.setCreator(c.creator, true);

        evaluator.transferOwnership(c.ownerSafe);
        resolver.transferOwnership(c.ownerSafe);
        router.transferOwnership(c.ownerSafe);
        vm.stopBroadcast();
    }

    function _router(Config memory c) internal returns (FeeRouter) {
        return new FeeRouter(
            c.deployer,
            c.usdg,
            vm.envAddress("FEE_WORK"),
            vm.envAddress("FEE_TREASURY"),
            vm.envAddress("FEE_PERKS"),
            vm.envAddress("FEE_BURN")
        );
    }
}
