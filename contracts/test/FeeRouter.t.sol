// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./utils/IfsoFixture.sol";

contract FeeRouterTest is IfsoFixture {
    function test_Distribute_80_10_5_5() public {
        usdg.mint(address(router), 1_000_001);
        router.distribute();
        assertEq(usdg.balanceOf(address(0xF2)), 100_000, "treasury 10%");
        assertEq(usdg.balanceOf(address(0xF3)), 50_000, "perks 5%");
        assertEq(usdg.balanceOf(address(0xF4)), 50_000, "burn 5%");
        assertEq(usdg.balanceOf(address(0xF1)), 800_001, "work 80% + dust");
    }

    function test_SweepCannotTouchUsdg() public {
        vm.expectRevert(FeeRouter.NotSweepable.selector);
        router.sweep(address(usdg));
    }
}
