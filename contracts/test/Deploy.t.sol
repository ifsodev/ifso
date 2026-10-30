// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase, Vm} from "./utils/TestBase.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DeployBase} from "../script/DeployBase.sol";

/// @notice Deploy safety (R8): the deploy script refuses on Robinhood Chain unless armed, every broadcasting script
///         carries the guard, and a local run passes the post-deploy assertions with the launch values.
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
