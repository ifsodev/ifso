// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeployBase} from "./DeployBase.sol";
import {IfsoEscrow} from "../src/IfsoEscrow.sol";
import {IfsoConditionEvaluator} from "../src/IfsoConditionEvaluator.sol";
import {IfsoOutcomeResolver} from "../src/IfsoOutcomeResolver.sol";
import {FeeRouter} from "../src/FeeRouter.sol";

/// @notice Re-runs the post-deploy assertions against a live chain. Read-only (never broadcasts).
///
///   forge script script/PostDeployCheck.s.sol --rpc-url <rpc>
///
/// What it checks, beyond the in-script assertions of Deploy.s.sol:
///   - On 4663 the launch values come from constants in DeployBase (USDG, feed proxies and Stock Tokens, cap, fees,
///     bond, windows, Safe singletons), never from the JSON the deploy wrote. The addresses that are only known at
///     deploy time (owner Safe, panel Safe, resolver creator, fee recipients) must be pinned by the operator with
///     EXPECT_OWNER_MULTISIG, EXPECT_PANEL_MULTISIG, EXPECT_RESOLVER_CREATOR and EXPECT_FEE_WORK / _TREASURY /
///     _PERKS / _BURN; the JSON must agree with each pin.
///   - Runtime bytecode of all four contracts equals the build output, immutables masked.
///   - Every contract's recorded constructorArgs match the constructor (input count from the build ABI) and the
///     deployed wiring, so the record can be used to verify source and to rebuild the deploy.
///   - On 4663 the deployment record carries the creation tx hash of every contract.
///   - REQUIRE_HANDED_OVER=1: the multisig accepted ownership everywhere and the deployer holds no role. Without the
///     flag the check passes both before and after the multisig accepts.
contract PostDeployCheck is DeployBase {
    string[4] internal names = ["IfsoConditionEvaluator", "IfsoOutcomeResolver", "FeeRouter", "IfsoEscrow"];

    /// @notice Loads the deployment file for the connected chain and asserts every value on chain.
    function run() external {
        string memory json = vm.readFile(_deploymentPath());
        Expect memory x = _expectFrom(json);
        if (block.chainid == RHC_MAINNET) _checkPins(x);

        address[4] memory a;
        for (uint256 i; i < 4; ++i) {
            a[i] = vm.parseJsonAddress(json, string.concat(".contracts.", names[i], ".address"));
            _checkRuntimeCode(a[i], names[i]);
            if (block.chainid == RHC_MAINNET) {
                _check(
                    vm.parseJsonBytes32(json, string.concat(".contracts.", names[i], ".creationTx")) != bytes32(0),
                    string.concat(names[i], ": no creation tx hash in the deployment record")
                );
            }
        }
        _assertDeployment(IfsoConditionEvaluator(a[0]), IfsoOutcomeResolver(a[1]), FeeRouter(a[2]), IfsoEscrow(a[3]), x);
        _checkConstructorArgs(json, a, x);
        if (keccak256(bytes(vm.envOr("REQUIRE_HANDED_OVER", string("0")))) == keccak256("1")) {
            _checkHandedOver(
                IfsoConditionEvaluator(a[0]), IfsoOutcomeResolver(a[1]), FeeRouter(a[2]), IfsoEscrow(a[3]), x
            );
        }
    }

    function _expectFrom(string memory json) internal pure returns (Expect memory x) {
        x.deployer = vm.parseJsonAddress(json, ".deployer");
        x.ownerMultisig = vm.parseJsonAddress(json, ".config.ownerMultisig");
        x.panel = vm.parseJsonAddress(json, ".config.panelMultisig");
        x.creator = vm.parseJsonAddress(json, ".config.resolverCreator");
        x.usdg = vm.parseJsonAddress(json, ".config.usdg");
        x.pyth = vm.parseJsonAddress(json, ".config.pyth");
        x.seqFeed = vm.parseJsonAddress(json, ".config.sequencerUptimeFeed");
        x.feeRecipients = [
            vm.parseJsonAddress(json, ".config.feeWork"),
            vm.parseJsonAddress(json, ".config.feeTreasury"),
            vm.parseJsonAddress(json, ".config.feePerks"),
            vm.parseJsonAddress(json, ".config.feeBurn")
        ];
        x.creationFee = uint96(vm.parseJsonUint(json, ".config.creationFee"));
        x.resolverFee = uint96(vm.parseJsonUint(json, ".config.resolverFee"));
        x.bond = uint96(vm.parseJsonUint(json, ".config.resolverBond"));
        x.maxAmount = uint96(vm.parseJsonUint(json, ".config.maxAmount"));
        x.disputeWindow = uint64(vm.parseJsonUint(json, ".config.disputeWindow"));
        x.panelWindow = uint64(vm.parseJsonUint(json, ".config.panelWindow"));
        x.feeds = vm.parseJsonAddressArray(json, ".config.feeds");
        x.feedTokens = vm.parseJsonAddressArray(json, ".config.feedStockTokens");
    }

    /// @dev Operator pins for the deploy-time addresses; a missing pin fails (never falls back to the JSON).
    function _checkPins(Expect memory x) internal view {
        _pin("EXPECT_OWNER_MULTISIG", x.ownerMultisig);
        _pin("EXPECT_PANEL_MULTISIG", x.panel);
        _pin("EXPECT_RESOLVER_CREATOR", x.creator);
        _pin("EXPECT_FEE_WORK", x.feeRecipients[0]);
        _pin("EXPECT_FEE_TREASURY", x.feeRecipients[1]);
        _pin("EXPECT_FEE_PERKS", x.feeRecipients[2]);
        _pin("EXPECT_FEE_BURN", x.feeRecipients[3]);
    }

    function _pin(string memory name, address recorded) internal view {
        address pinned = vm.envOr(name, address(0));
        _check(pinned != address(0), string.concat(name, " is not set"));
        _check(pinned == recorded, string.concat(name, " differs from the deployment record"));
    }
}
