// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase, Vm} from "./utils/TestBase.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DeployBase} from "../script/DeployBase.sol";

/// @notice Exposes the PostDeployCheck pieces added before mainnet (audit-grade deploy readiness).
contract PostDeployProbe is DeployBase {
    function runtimeCode(address a, string memory name) external view {
        _checkRuntimeCode(a, name);
    }

    function mainnetConstants(Expect memory x) external view {
        _checkMainnetConstants(x);
    }

    function handedOver(Deploy.Deployed memory d, Expect memory x) external view {
        _checkHandedOver(d.evaluator, d.resolver, d.router, d.escrow, x);
    }

    /// @dev The launch values as the 4663 deploy would record them.
    function launchExpect() external pure returns (Expect memory x) {
        x.usdg = RHC_USDG;
        x.maxAmount = MAINNET_CAP;
        x.creationFee = MAINNET_CREATION_FEE;
        x.resolverFee = MAINNET_RESOLVER_FEE;
        x.bond = MAINNET_BOND;
        x.disputeWindow = DISPUTE_WINDOW;
        x.panelWindow = PANEL_WINDOW;
        (x.feeds, x.feedTokens) = _mainnetFeeds();
    }
}

/// @notice Exposes the deployment record exactly as Deploy.s.sol writes it (without touching the file).
contract DeployRecordProbe is Deploy {
    function record(Deployed memory d, Expect memory x) external view returns (string memory) {
        return _record(d, x);
    }

    function resolverArgs(string memory json, Deploy.Deployed memory d, Expect memory x) external view {
        _checkArgs(json, "IfsoOutcomeResolver", _resolverArgs(x, address(d.router)));
    }

    function constructorArgs(string memory json, Deploy.Deployed memory d, Expect memory x) external view {
        _checkConstructorArgs(
            json, [address(d.evaluator), address(d.resolver), address(d.router), address(d.escrow)], x
        );
    }
}

/// @notice PostDeployCheck readiness: hard-coded 4663 launch values, runtime bytecode against the build, and the
///         "handed over" mode. The full script runs against a local anvil fork in script/fork-dryrun.sh.
contract PostDeployCheckTest is TestBase {
    function _setEnv() internal {
        vm.setEnv("OWNER_MULTISIG", vm.toString(address(0x0A11)));
        vm.setEnv("PANEL_MULTISIG", vm.toString(address(0x0A12)));
        vm.setEnv("RESOLVER_CREATOR", vm.toString(address(0x0A13)));
        vm.setEnv("FEE_WORK", vm.toString(address(0xF1)));
        vm.setEnv("FEE_TREASURY", vm.toString(address(0xF2)));
        vm.setEnv("FEE_PERKS", vm.toString(address(0xF3)));
        vm.setEnv("FEE_BURN", vm.toString(address(0xF4)));
        vm.setEnv("IFSO_WRITE_DEPLOYMENT", "0");
    }

    /// @notice PostDeployCheck: runtime code of every contract equals the build output with immutables masked, and a
    ///         single changed byte outside the immutables fails.
    function test_PostDeploy_RuntimeCodeMatchesBuild() public {
        _setEnv();
        vm.chainId(31337);
        Deploy.Deployed memory d = Deploy(_deployArtifact("Deploy.s.sol:Deploy")).run();
        PostDeployProbe p = new PostDeployProbe();
        p.runtimeCode(address(d.evaluator), "IfsoConditionEvaluator");
        p.runtimeCode(address(d.resolver), "IfsoOutcomeResolver");
        p.runtimeCode(address(d.router), "FeeRouter");
        p.runtimeCode(address(d.escrow), "IfsoEscrow");
        bytes memory code = address(d.router).code;
        code[code.length - 1] = code[code.length - 1] ^ 0x01;
        vm.etch(address(d.router), code);
        vm.expectRevert(
            abi.encodeWithSelector(DeployBase.CheckFailed.selector, "FeeRouter: runtime code differs from the build")
        );
        p.runtimeCode(address(d.router), "FeeRouter");
        vm.etch(address(d.router), address(d.resolver).code);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBase.CheckFailed.selector, "FeeRouter: runtime code length differs from the build"
            )
        );
        p.runtimeCode(address(d.router), "FeeRouter");
    }

    /// @notice On 4663 the launch values are hard-coded: the exact values pass, any drift fails.
    function test_PostDeploy_MainnetConstants() public {
        PostDeployProbe p = new PostDeployProbe();
        DeployBase.Expect memory x = p.launchExpect();
        vm.chainId(4663);
        p.mainnetConstants(x);
        x.maxAmount = 999e6;
        vm.expectRevert(abi.encodeWithSelector(DeployBase.CheckFailed.selector, "mainnet: launch cap != 1,000 USDG"));
        p.mainnetConstants(x);
        x = p.launchExpect();
        x.usdg = address(0xBAD);
        vm.expectRevert(abi.encodeWithSelector(DeployBase.CheckFailed.selector, "mainnet: USDG is not the RHC USDG"));
        p.mainnetConstants(x);
        x = p.launchExpect();
        x.feeds[2] = address(0xBAD);
        vm.expectRevert(abi.encodeWithSelector(DeployBase.CheckFailed.selector, "mainnet: feed proxy mismatch"));
        p.mainnetConstants(x);
        x = p.launchExpect();
        x.panelWindow = 24 hours;
        vm.expectRevert(abi.encodeWithSelector(DeployBase.CheckFailed.selector, "mainnet: panel window != 72 h"));
        p.mainnetConstants(x);
        vm.chainId(31337);
        p.mainnetConstants(x); // other chains: not applied
    }

    /// @notice REQUIRE_HANDED_OVER: fails while ownership is pending, passes once the multisig accepted everywhere,
    ///         and fails if the deployer kept a role.
    function test_PostDeploy_HandedOverMode() public {
        _setEnv();
        vm.chainId(31337);
        Deploy.Deployed memory d = Deploy(_deployArtifact("Deploy.s.sol:Deploy")).run();
        PostDeployProbe p = new PostDeployProbe();
        DeployBase.Expect memory x;
        x.deployer = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38; // forge's default broadcaster in tests
        x.ownerMultisig = address(0x0A11);
        x.panel = address(0x0A12);
        x.creator = address(0x0A13);
        assertEq(d.escrow.owner(), x.deployer, "deployer owns until accepted");
        vm.expectRevert(
            abi.encodeWithSelector(DeployBase.CheckFailed.selector, "handed over: owner is not the multisig")
        );
        p.handedOver(d, x);

        uint256 snap = vm.snapshotState();
        vm.prank(x.deployer);
        d.resolver.setCreator(x.deployer, true); // the deployer keeps a role before handing over
        _acceptAll(d, x.ownerMultisig);
        vm.expectRevert(
            abi.encodeWithSelector(DeployBase.CheckFailed.selector, "handed over: deployer can create questions")
        );
        p.handedOver(d, x);
        vm.revertToState(snap);

        _acceptAll(d, x.ownerMultisig);
        p.handedOver(d, x);
    }

    function _acceptAll(Deploy.Deployed memory d, address ms) internal {
        vm.startPrank(ms);
        d.evaluator.acceptOwnership();
        d.resolver.acceptOwnership();
        d.router.acceptOwnership();
        d.escrow.acceptOwnership();
        vm.stopPrank();
    }
}

/// @notice The deployment record against the deployed constructor arguments (own contract: the test contract that
///         embeds the full deploy twice would pass the code size limit).
contract DeployRecordTest is TestBase {
    function _setEnv() internal {
        vm.setEnv("OWNER_MULTISIG", vm.toString(address(0x0A11)));
        vm.setEnv("PANEL_MULTISIG", vm.toString(address(0x0A12)));
        vm.setEnv("RESOLVER_CREATOR", vm.toString(address(0x0A13)));
        vm.setEnv("FEE_WORK", vm.toString(address(0xF1)));
        vm.setEnv("FEE_TREASURY", vm.toString(address(0xF2)));
        vm.setEnv("FEE_PERKS", vm.toString(address(0xF3)));
        vm.setEnv("FEE_BURN", vm.toString(address(0xF4)));
        vm.setEnv("IFSO_WRITE_DEPLOYMENT", "0");
    }

    /// @notice The record Deploy.s.sol writes carries every constructor argument of every contract (the resolver's
    ///         7th, feeRouter, was missing in the 2026-11-05 testnet record), and PostDeployCheck compares each one
    ///         against the constructor ABI and the deployed wiring: a missing, extra or wrong value fails.
    function test_PostDeploy_RecordConstructorArgsMatchDeployment() public {
        _setEnv();
        vm.chainId(31337);
        DeployRecordProbe r = new DeployRecordProbe();
        Deploy.Deployed memory d = r.run();
        DeployBase.Expect memory x = _localExpect(d);
        DeployRecordProbe p = r;
        string memory json = r.record(d, x);
        assertEq(
            vm.parseJsonAddress(json, ".contracts.IfsoOutcomeResolver.constructorArgs[6]"),
            address(d.router),
            "resolver arg 7 = feeRouter"
        );
        p.constructorArgs(json, d, x);

        // a record whose resolver entry has only 6 values (the old writer) fails
        string memory six = string.concat(
            '{"contracts": {"IfsoOutcomeResolver": {"constructorArgs": [',
            '"',
            vm.toString(x.deployer),
            '", "',
            vm.toString(x.usdg),
            '", 7200, 259200, ',
            vm.toString(uint256(x.bond)),
            ', "',
            vm.toString(x.panel),
            '"]}}}'
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBase.CheckFailed.selector, "IfsoOutcomeResolver: constructorArgs[6] missing from the record"
            )
        );
        p.resolverArgs(six, d, x);

        // a recorded value that differs from the deployment fails
        DeployBase.Expect memory y = _localExpect(d);
        y.panel = address(0xBAD);
        string memory wrong = r.record(d, y);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBase.CheckFailed.selector, "IfsoOutcomeResolver: constructorArgs[5] differs from the deployment"
            )
        );
        p.constructorArgs(wrong, d, x);

        // an extra value fails
        string memory eight = string.concat(
            '{"contracts": {"IfsoOutcomeResolver": {"constructorArgs": [',
            '"',
            vm.toString(x.deployer),
            '", "',
            vm.toString(x.usdg),
            '", 7200, 259200, ',
            vm.toString(uint256(x.bond)),
            ', "',
            vm.toString(x.panel),
            '", "',
            vm.toString(address(d.router)),
            '", 1]}}}'
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBase.CheckFailed.selector,
                "IfsoOutcomeResolver: constructorArgs has more values than the constructor"
            )
        );
        p.resolverArgs(eight, d, x);
    }

    /// @dev What Deploy.s.sol builds internally for the local run in `_setEnv`.
    function _localExpect(Deploy.Deployed memory d) internal view returns (DeployBase.Expect memory x) {
        x.deployer = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38; // forge's default broadcaster in tests
        x.ownerMultisig = address(0x0A11);
        x.panel = address(0x0A12);
        x.creator = address(0x0A13);
        x.usdg = address(d.escrow.usdg());
        x.feeRecipients = [address(0xF1), address(0xF2), address(0xF3), address(0xF4)];
        x.creationFee = d.escrow.creationFee();
        x.resolverFee = d.escrow.resolverFee();
        x.bond = d.resolver.bondAmount();
        x.maxAmount = d.escrow.maxAmount();
        x.disputeWindow = d.resolver.disputeWindow();
        x.panelWindow = d.resolver.panelWindow();
    }
}
