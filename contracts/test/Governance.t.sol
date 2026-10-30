// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./utils/IfsoFixture.sol";
import {Owned2Step} from "../src/utils/Owned2Step.sol";

/// @notice Two-step ownership on every owned contract, and the FeeRouter admin and edge paths.
contract GovernanceTest is IfsoFixture {
    function _owned() internal view returns (Owned2Step[4] memory o) {
        o = [
            Owned2Step(address(escrow)),
            Owned2Step(address(evaluator)),
            Owned2Step(address(resolver)),
            Owned2Step(address(router))
        ];
    }

    function test_TwoStepOwnership_OnEveryOwnedContract() public {
        Owned2Step[4] memory o = _owned();
        for (uint256 i; i < o.length; ++i) {
            vm.prank(attacker);
            vm.expectRevert(Owned2Step.NotOwner.selector);
            o[i].transferOwnership(attacker);

            vm.prank(owner);
            o[i].transferOwnership(alt);
            assertEq(o[i].owner(), owner, "owner unchanged until accepted");
            vm.prank(attacker);
            vm.expectRevert(Owned2Step.NotPendingOwner.selector);
            o[i].acceptOwnership();
            vm.prank(alt);
            o[i].acceptOwnership();
            assertEq(o[i].owner(), alt, "new owner");
            assertEq(o[i].pendingOwner(), address(0), "pending cleared");
            vm.prank(owner);
            vm.expectRevert(Owned2Step.NotOwner.selector);
            o[i].transferOwnership(owner); // the old owner has no power left
        }
    }

    function test_ZeroOwnerRefusedAtDeploy() public {
        vm.expectRevert(Owned2Step.ZeroAddress.selector);
        new FeeRouter(address(0), address(usdg), address(1), address(2), address(3), address(4));
    }

    function test_Router_SetRecipients_OwnerOnly_NoZero() public {
        vm.prank(attacker);
        vm.expectRevert(Owned2Step.NotOwner.selector);
        router.setRecipients(attacker, attacker, attacker, attacker);
        vm.startPrank(owner);
        vm.expectRevert(Owned2Step.ZeroAddress.selector);
        router.setRecipients(address(1), address(2), address(3), address(0));
        vm.expectRevert(Owned2Step.ZeroAddress.selector);
        router.setRecipients(address(0), address(2), address(3), address(4));
        router.setRecipients(address(0x11), address(0x12), address(0x13), address(0x14));
        vm.stopPrank();
        usdg.mint(address(router), 1_000_000);
        router.distribute();
        assertEq(usdg.balanceOf(address(0x11)), 800_000, "work");
        assertEq(usdg.balanceOf(address(0x12)), 100_000, "treasury");
        assertEq(usdg.balanceOf(address(0x13)), 50_000, "perks");
        assertEq(usdg.balanceOf(address(0x14)), 50_000, "burn");
    }

    function test_Router_DistributeEmptyDoesNothing_DustGoesToWork() public {
        router.distribute(); // balance 0: no revert, nothing moves
        usdg.mint(address(router), 9);
        router.distribute();
        assertEq(usdg.balanceOf(address(0xF1)), 9, "all dust to work");
        assertEq(usdg.balanceOf(address(router)), 0, "router empty");
    }

    function test_Router_SweepsOtherTokensToTreasury() public {
        MockUSDG other = new MockUSDG();
        other.mint(address(router), 77e6);
        router.sweep(address(other));
        assertEq(other.balanceOf(address(0xF2)), 77e6, "treasury received the stray token");
        assertEq(other.balanceOf(address(router)), 0, "router empty");
    }
}
