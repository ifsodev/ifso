// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase, Vm} from "./utils/TestBase.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DeployBase} from "../script/DeployBase.sol";

/// @notice Deploy safety (R8): the deploy script refuses on Robinhood Chain unless armed, every broadcasting script
///         carries the guard, and a local run passes the post-deploy assertions with the launch values.
/// @notice Exposes the deploy assertions that review round 1 added.
contract DeployChecksProbe is DeployBase {
    function cap(uint96 m) external view {
        _checkLaunchCap(m);
    }

    function pythOff(address p) external view {
        _checkPythOff(p);
    }

    function multisig(address a) external view {
        _checkMultisig(a, "owner");
    }

    function armed() external {
        _requireArmed();
    }
}

contract DeployTest is TestBase {
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

    function test_Deploy_RefusesUnarmedOnRealChainIds() public {
        _setEnv();
        uint256[2] memory ids = [uint256(4663), 46630];
        for (uint256 i; i < 2; ++i) {
            assertFalse(vm.exists(string.concat(".armed-", vm.toString(ids[i]))), "arming file must not exist here");
            vm.chainId(ids[i]);
            Deploy d = new Deploy();
            // env flag missing
            vm.setEnv("IFSO_ARMED", "0");
            vm.expectRevert(abi.encodeWithSelector(DeployBase.NotArmed.selector, ids[i]));
            d.run();
            // env flag set but no arming file: still refuses
            vm.setEnv("IFSO_ARMED", "1");
            vm.expectRevert(abi.encodeWithSelector(DeployBase.NotArmed.selector, ids[i]));
            d.run();
            vm.setEnv("IFSO_ARMED", "0");
        }
    }

    /// @notice R1-I6: the guard covers every chain but a local anvil, not only Robinhood Chain.
    function test_R1_I6_RefusesUnarmedOnAnyNonLocalChain() public {
        DeployChecksProbe p = new DeployChecksProbe();
        vm.setEnv("IFSO_ARMED", "0");
        uint256[4] memory ids = [uint256(1), 42161, 8453, 11155111];
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            vm.expectRevert(abi.encodeWithSelector(DeployBase.NotArmed.selector, ids[i]));
            p.armed();
        }
        vm.chainId(31337);
        p.armed(); // local anvil passes
    }

    /// @notice R1-L4: on 4663 / 46630 the launch cap must be on and at most 1,000 USDG; local chains are free.
    function test_R1_L4_LaunchCapRequiredOnRhc() public {
        DeployChecksProbe p = new DeployChecksProbe();
        uint256[2] memory ids = [uint256(4663), 46630];
        for (uint256 i; i < 2; ++i) {
            vm.chainId(ids[i]);
            vm.expectRevert(
                abi.encodeWithSelector(DeployBase.CheckFailed.selector, "launch cap must be 1..1,000 USDG on RHC")
            );
            p.cap(0);
            vm.expectRevert(
                abi.encodeWithSelector(DeployBase.CheckFailed.selector, "launch cap must be 1..1,000 USDG on RHC")
            );
            p.cap(1_000e6 + 1);
            p.cap(1_000e6);
            p.cap(1e6);
        }
        vm.chainId(31337);
        p.cap(0);
    }

    /// @notice R1-L2: Pyth must be unwired (pyth = 0) on Robinhood Chain in v1, and the deploy default is 0.
    function test_R1_L2_PythOffOnRhc() public {
        DeployChecksProbe p = new DeployChecksProbe();
        vm.chainId(4663);
        vm.expectRevert(
            abi.encodeWithSelector(DeployBase.CheckFailed.selector, "Pyth must be off (pyth = 0) on RHC in v1")
        );
        p.pythOff(0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a);
        p.pythOff(address(0));
        vm.chainId(31337);
        _setEnv();
        Deploy.Deployed memory d = new Deploy().run();
        assertEq(address(d.evaluator.pyth()), address(0), "deploy default: no Pyth");
    }

    /// @notice R1-L4: an EOA, an EIP-7702 delegated EOA and a look-alike contract with a threshold getter all fail
    ///         the Safe check (the real-Safe cases run on a fork: testFork_R1_L4_SafeCheck).
    function test_R1_L4_MultisigRejectsNonSafes() public {
        DeployChecksProbe p = new DeployChecksProbe();
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(DeployBase.CheckFailed.selector, "owner: no code (an EOA)"));
        p.multisig(address(0xE0A));
        address delegated = address(0x7702);
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(0x1234)));
        vm.expectRevert(
            abi.encodeWithSelector(DeployBase.CheckFailed.selector, "owner: not an official SafeProxy (codehash)")
        );
        p.multisig(delegated);
        LookAlikeSafe fake = new LookAlikeSafe();
        vm.expectRevert(
            abi.encodeWithSelector(DeployBase.CheckFailed.selector, "owner: not an official SafeProxy (codehash)")
        );
        p.multisig(address(fake));
    }

    /// @notice Every script under script/ that broadcasts must call the armed-flag guard (a written
    ///         promise of a guard is not a guard; the code is checked).
    function test_Deploy_EveryBroadcastingScriptIsGuarded() public view {
        Vm.DirEntry[] memory entries = vm.readDir("script");
        uint256 broadcasting;
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i].isDir || !_endsWith(entries[i].path, ".sol")) continue;
            string memory src = vm.readFile(entries[i].path);
            if (_contains(src, "startBroadcast(") || _contains(src, "vm.broadcast(")) {
                broadcasting++;
                assertTrue(
                    _contains(src, "_requireArmed();"), string.concat("unguarded broadcaster: ", entries[i].path)
                );
            }
        }
        assertGt(broadcasting, 0, "found the deploy script");
    }

    /// @notice Full local run of the deploy script with its default (launch) values; the in-script post-deploy
    ///         assertions run at the end (owners pending = multisig, fees, 1,000 USDG cap, feeds, panel).
    function test_Deploy_LocalRunPassesAssertions() public {
        _setEnv();
        vm.chainId(31337);
        Deploy.Deployed memory d = new Deploy().run();
        assertEq(uint256(d.escrow.maxAmount()), 1_000e6, "launch cap");
        assertEq(uint256(d.escrow.creationFee()), 250_000, "creation fee");
        assertEq(d.escrow.pendingOwner(), address(0x0A11), "escrow pending owner = multisig");
        assertEq(d.evaluator.pendingOwner(), address(0x0A11), "evaluator pending owner = multisig");
        assertEq(d.resolver.panel(), address(0x0A12), "panel");
    }

    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i; i <= h.length - n.length; ++i) {
            bool ok = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    function _endsWith(string memory s, string memory suf) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(suf);
        if (b.length > a.length) return false;
        for (uint256 i; i < b.length; ++i) {
            if (a[a.length - b.length + i] != b[i]) return false;
        }
        return true;
    }
}

/// @dev Answers like a 2-of-3 Safe with the official singleton in slot 0, but is not a SafeProxy.
contract LookAlikeSafe {
    address internal singleton = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;

    function getThreshold() external pure returns (uint256) {
        return 2;
    }

    function getModulesPaginated(address, uint256) external pure returns (address[] memory a, address n) {}
}
