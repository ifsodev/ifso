// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeployBase} from "./DeployBase.sol";
import {IfsoEscrow} from "../src/IfsoEscrow.sol";
import {IfsoConditionEvaluator} from "../src/IfsoConditionEvaluator.sol";
import {IfsoOutcomeResolver} from "../src/IfsoOutcomeResolver.sol";
import {FeeRouter} from "../src/FeeRouter.sol";

/// @notice Re-runs the post-deploy assertions against a live chain from `deployments/<chainid>.json`.
///         Read-only (never broadcasts). Passes both before and after the multisig accepts ownership.
///
///   forge script script/PostDeployCheck.s.sol --rpc-url <rpc>
contract PostDeployCheck is DeployBase {
    /// @notice Loads the deployment file for the connected chain and asserts every recorded value on chain.
    function run() external view {
        string memory json = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        Expect memory x;
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

        _assertDeployment(
            IfsoConditionEvaluator(vm.parseJsonAddress(json, ".contracts.IfsoConditionEvaluator.address")),
            IfsoOutcomeResolver(vm.parseJsonAddress(json, ".contracts.IfsoOutcomeResolver.address")),
            FeeRouter(vm.parseJsonAddress(json, ".contracts.FeeRouter.address")),
            IfsoEscrow(vm.parseJsonAddress(json, ".contracts.IfsoEscrow.address")),
            x
        );
    }
}
