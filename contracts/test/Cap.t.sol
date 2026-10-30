// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./utils/IfsoFixture.sol";

/// @notice Launch cap (maxAmount): gates NEW creates and challenge accepts only, never exits.
contract CapTest is IfsoFixture {
    uint96 internal constant CAP = 1_000e6;

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        escrow.setMaxAmount(CAP);
    }

    function _challengeParams(Condition memory c, uint96 amount, uint96 counter)
        internal
        returns (CreateParams memory p)
    {
        p = _params(c, recipient, address(0), amount, uint64(T0 + 10 days));
        p.twoSided = true;
        p.counterAmount = counter;
        p.acceptBy = uint64(T0 + 1 days);
    }

    // R1
    function test_Cap_AboveReverts_AtCapPasses() public {
        // one-sided: at cap passes, one unit above reverts
        _create(_params(_time(uint64(T0 + 1 days)), recipient, address(0), CAP, uint64(T0 + 3 days)));
        CreateParams memory p = _params(_time(uint64(T0 + 1 days)), recipient, address(0), CAP + 1, uint64(T0 + 3 days));
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.AmountAboveCap.selector);
        escrow.create(p);

        // two-sided: either side above the cap reverts; both at cap passes
        _create(_challengeParams(_referee(referee), CAP, CAP));
        p = _challengeParams(_referee(referee), CAP, CAP + 1);
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.AmountAboveCap.selector);
        escrow.create(p);
        p = _challengeParams(_referee(referee), CAP + 1, CAP);
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.AmountAboveCap.selector);
        escrow.create(p);

        // batch: one oversized row reverts the whole batch
        CreateParams[] memory ps = new CreateParams[](2);
        ps[0] = _params(_time(uint64(T0 + 1 days)), recipient, address(0), CAP, uint64(T0 + 3 days));
        ps[1] = _params(_time(uint64(T0 + 1 days)), recipient, address(0), CAP + 1, uint64(T0 + 3 days));
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.AmountAboveCap.selector);
        escrow.createBatch(ps);

        // cap 0 = no cap
        vm.prank(owner);
        escrow.setMaxAmount(0);
        _create(_params(_time(uint64(T0 + 1 days)), recipient, address(0), CAP + 1, uint64(T0 + 3 days)));
    }

    function testFuzz_Cap_Boundary(uint96 cap, uint96 amount) public {
        cap = uint96(bound(cap, 1e6, 100_000e6));
        amount = uint96(bound(amount, 1e6, 200_000e6));
        vm.prank(owner);
        escrow.setMaxAmount(cap);
        CreateParams memory p = _params(_time(uint64(T0 + 1 days)), recipient, address(0), amount, uint64(T0 + 3 days));
        vm.prank(sender);
        if (amount > cap) vm.expectRevert(IIfsoEscrow.AmountAboveCap.selector);
        escrow.create(p);
    }

    // R2 (exits)
    function test_Cap_LoweredDoesNotBlockExits() public {
        uint64 exp = uint64(T0 + 10 days);
        uint256 timeId = _create(_params(_time(uint64(T0 + 1 days)), recipient, address(0), CAP, exp));
        uint256 linkId = _create(_params(_time(uint64(T0 + 1 days)), address(0), linkKey, CAP, exp));
        uint256 partiesId = _create(_params(_parties(), recipient, address(0), CAP, exp));
        uint256 declineId = _create(_params(_parties(), recipient, address(0), CAP, exp));
        uint256 refId = _create(_challengeParams(_referee(referee), CAP, CAP));
        CreateParams memory cp = _params(_time(uint64(T0 + 1 days)), recipient, address(0), CAP, exp);
        cp.cancellable = true;
        uint256 cancelId = _create(cp);
        uint256 refundId = _create(_params(_time(uint64(T0 + 1 days)), recipient, address(0), CAP, exp));
        vm.prank(recipient);
        escrow.accept(refId, "", address(0)); // accepted while the cap allowed it

        // owner lowers the cap to the minimum and pauses: every exit still works
        vm.startPrank(owner);
        escrow.setMaxAmount(1e6);
        escrow.setCreationPaused(true);
        vm.stopPrank();

        escrow.claim(linkId, recipientEoa, _claimSig(linkPk, linkId, recipientEoa)); // claim
        vm.prank(sender);
        escrow.cancel(cancelId); // cancel
        vm.prank(sender);
        escrow.approve(partiesId);
        vm.prank(recipient);
        escrow.approve(partiesId); // decisions
        vm.prank(recipient);
        escrow.decline(declineId);
        vm.prank(referee);
        escrow.refereeDecide(refId, true);

        vm.warp(T0 + 1 days);
        escrow.settle(timeId, "", false); // settle
        escrow.settle(linkId, "", false);

        vm.warp(exp);
        vm.prank(attacker);
        escrow.refund(refundId, false, false); // refund by anyone

        assertTrue(_status(timeId) == Status.RELEASED, "settle");
        assertTrue(_status(linkId) == Status.RELEASED, "claim+settle");
        assertTrue(_status(partiesId) == Status.RELEASED, "approve");
        assertTrue(_status(declineId) == Status.RETURNED, "decline");
        assertTrue(_status(refId) == Status.RELEASED, "referee");
        assertTrue(_status(cancelId) == Status.CANCELLED, "cancel");
        assertTrue(_status(refundId) == Status.RETURNED, "refund");
        assertEq(usdg.balanceOf(address(escrow)), 0, "everything exited");
    }

    // R2 (accept is a new entry)
    function test_Cap_AcceptGated() public {
        uint256 id = _create(_challengeParams(_referee(referee), CAP, CAP));
        vm.prank(owner);
        escrow.setMaxAmount(CAP - 1);
        vm.prank(recipient);
        vm.expectRevert(IIfsoEscrow.AmountAboveCap.selector);
        escrow.accept(id, "", address(0));

        // the sender can still take its money back (cancel an unaccepted challenge)
        uint256 sb = usdg.balanceOf(sender);
        vm.prank(sender);
        escrow.cancel(id);
        assertEq(usdg.balanceOf(sender) - sb, CAP, "unaccepted challenge exits under a lower cap");

        // raising the cap back lets the accept through
        uint256 id2 = _create(_challengeParams(_referee(referee), CAP - 1, CAP - 1));
        vm.prank(owner);
        escrow.setMaxAmount(CAP - 2);
        vm.prank(recipient);
        vm.expectRevert(IIfsoEscrow.AmountAboveCap.selector);
        escrow.accept(id2, "", address(0));
        vm.prank(owner);
        escrow.setMaxAmount(CAP);
        vm.prank(recipient);
        escrow.accept(id2, "", address(0));
        assertTrue(escrow.getEscrow(id2).flags & 2 != 0, "accepted");
    }

    // R3
    function test_Cap_OnlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert(bytes4(keccak256("NotOwner()")));
        escrow.setMaxAmount(1);
        vm.prank(sender);
        vm.expectRevert(bytes4(keccak256("NotOwner()")));
        escrow.setMaxAmount(0);
        assertEq(escrow.maxAmount(), CAP, "unchanged");

        vm.prank(owner);
        vm.expectRevert(IIfsoEscrow.InvalidParams.selector); // a non-zero cap below MIN_AMOUNT would block everything
        escrow.setMaxAmount(1e6 - 1);
        vm.prank(owner);
        escrow.setMaxAmount(type(uint96).max);
        assertEq(escrow.maxAmount(), escrow.MAX_AMOUNT_CAP(), "ceiling");
    }
}
