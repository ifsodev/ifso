// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./utils/IfsoFixture.sol";

contract IfsoEscrowTest is IfsoFixture {
    // ------------------------------------------------------------- TIME + fees
    function test_Time_NamedRecipient_FlatFee_SettlesAfterDeadline() public {
        uint256 before = usdg.balanceOf(sender);
        uint256 id = _create(_named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        assertEq(before - usdg.balanceOf(sender), 20e6 + FEE, "sender pays amount + flat fee");
        assertEq(usdg.balanceOf(address(router)), FEE, "fee routed at creation");
        assertEq(usdg.balanceOf(address(escrow)), 20e6, "escrow holds only the payment");

        vm.expectRevert(IIfsoEscrow.ConditionPending.selector);
        escrow.settle(id, "", false);

        vm.warp(T0 + 1 days);
        uint256 rb = usdg.balanceOf(recipient);
        vm.prank(keeper);
        escrow.settle(id, "", false);
        assertEq(usdg.balanceOf(recipient) - rb, 20e6, "recipient paid full amount (no % fee)");
        assertTrue(_status(id) == Status.RELEASED, "released");

        vm.expectRevert(IIfsoEscrow.NotOpen.selector);
        escrow.settle(id, "", false);
    }

    function test_Create_RejectsDustBothRecipientsAndBadExpiry() public {
        CreateParams memory p = _named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days));
        p.amount = 1e6 - 1;
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.InvalidParams.selector);
        escrow.create(p);

        p = _named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days));
        p.linkKey = linkKey; // both set
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.InvalidParams.selector);
        escrow.create(p);

        p = _named(_time(uint64(T0 + 1 days)), uint64(T0 + 401 days));
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.InvalidParams.selector);
        escrow.create(p);
    }

    function test_Create_TimeNeedsClaimWindow() public {
        CreateParams memory p = _named(_time(uint64(T0 + 1 days)), uint64(T0 + 1 days + 1 hours));
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);
    }

    function test_DuplicateSalt_Reverts() public {
        CreateParams memory p = _named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days));
        _create(p);
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.AlreadyExists.selector);
        escrow.create(p);
    }

    // ------------------------------------------------------------- claim links
    function test_Link_PreClaimBindsThenSettlePays() public {
        uint256 id = _create(_link(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        bytes memory sig = _claimSig(linkPk, id, recipient);
        vm.prank(keeper); // relayer pays gas; recipient never transacts
        escrow.claim(id, recipient, sig);
        assertEq(escrow.getEscrow(id).recipient, recipient, "bound");
        assertTrue(_status(id) == Status.OPEN, "still open until condition");

        vm.warp(T0 + 1 days);
        escrow.settle(id, "", false);
        assertTrue(_status(id) == Status.RELEASED, "released");
        assertEq(usdg.balanceOf(recipient), 1_000_000e6 + 20e6, "paid");
    }

    function test_Link_MetBeforeClaim_ClaimPaysImmediately() public {
        uint256 id = _create(_link(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        vm.warp(T0 + 1 days);
        escrow.settle(id, "", false);
        assertTrue(_status(id) == Status.MET, "met, waiting for claim");
        address fresh = address(0xC0FFEE); // counterfactual smart account: never transacted
        escrow.claim(id, fresh, _claimSig(linkPk, id, fresh));
        assertEq(usdg.balanceOf(fresh), 20e6, "claimed to fresh address");
        assertTrue(_status(id) == Status.RELEASED, "released");
    }

    function test_Link_FrontRunnerCannotRedirect() public {
        uint256 id = _create(_link(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        bytes memory sig = _claimSig(linkPk, id, recipient);
        // attacker copies the signature from the mempool and swaps in its own address
        vm.prank(attacker);
        vm.expectRevert(IIfsoEscrow.BadSignature.selector);
        escrow.claim(id, attacker, sig);
        // the honest claim still works afterwards
        escrow.claim(id, recipient, sig);
        assertEq(escrow.getEscrow(id).recipient, recipient, "bound to signed recipient");
    }

    function test_Link_WrongKeyAndSecondClaimRevert() public {
        uint256 id = _create(_link(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        bytes memory wrong = _claimSig(0xDEAD, id, attacker);
        vm.expectRevert(IIfsoEscrow.BadSignature.selector);
        escrow.claim(id, attacker, wrong);

        escrow.claim(id, recipient, _claimSig(linkPk, id, recipient));
        bytes memory sig2 = _claimSig(linkPk, id, attacker); // even with the real link key
        vm.expectRevert(IIfsoEscrow.AlreadyClaimed.selector);
        escrow.claim(id, attacker, sig2);
    }

    function test_Link_SignatureCommitsToConditionHash() public {
        uint256 id = _create(_link(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        bytes memory forged = _sig(linkPk, escrow.hashClaim(id, recipient, keccak256("other condition")));
        vm.expectRevert(IIfsoEscrow.BadSignature.selector);
        escrow.claim(id, recipient, forged);
    }

    function test_Link_ClaimAfterExpiryReverts() public {
        uint256 id = _create(_link(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        vm.warp(T0 + 3 days);
        bytes memory sig = _claimSig(linkPk, id, recipient);
        vm.expectRevert(IIfsoEscrow.Expired.selector);
        escrow.claim(id, recipient, sig);
    }

    // ------------------------------------------------------------- refunds
    function test_Refund_AfterExpiry_ByAnyone() public {
        uint256 id = _create(_link(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        vm.expectRevert(IIfsoEscrow.NotExpired.selector);
        escrow.refund(id, false, false);

        vm.warp(T0 + 1 days);
        escrow.settle(id, "", false); // MET but nobody claimed the link
        vm.warp(T0 + 3 days);
        uint256 sb = usdg.balanceOf(sender);
        vm.prank(attacker); // a stranger can trigger it; money still goes to the sender
        escrow.refund(id, false, false);
        assertEq(usdg.balanceOf(sender) - sb, 20e6, "refunded to sender");
        assertTrue(_status(id) == Status.RETURNED, "returned");
    }

    function test_Refund_AltAddressWhenPrimaryBlocked() public {
        CreateParams memory p = _named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days));
        p.altRefundTo = alt;
        uint256 id = _create(p);
        usdg.setBlocked(sender, true); // sender frozen / screened
        vm.warp(T0 + 3 days);
        vm.expectRevert();
        escrow.refund(id, false, false);
        escrow.refund(id, true, false);
        assertEq(usdg.balanceOf(alt), 20e6, "alt received refund");
    }

    function test_Refund_NoAlternateConfigured() public {
        uint256 id = _create(_named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        vm.warp(T0 + 3 days);
        vm.expectRevert(IIfsoEscrow.NoAlternate.selector);
        escrow.refund(id, true, false);
    }

    function test_RefundRedirectBySig_SenderNeverTransacts() public {
        uint256 id = _create(_named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        uint256 deadline = T0 + 1 hours;
        bytes memory sig = _sig(senderPk, escrow.hashRefundRedirect(id, alt, address(0), 0, deadline));
        vm.prank(keeper);
        escrow.setRefundAddressesBySig(id, alt, address(0), deadline, sig);
        vm.expectRevert(IIfsoEscrow.BadSignature.selector); // replay (nonce consumed)
        escrow.setRefundAddressesBySig(id, alt, address(0), deadline, sig);
        vm.warp(T0 + 3 days);
        escrow.refund(id, false, false);
        assertEq(usdg.balanceOf(alt), 20e6, "refund followed redirect");
    }

    function test_Pause_GatesOnlyNewEntries() public {
        uint256 id = _create(_link(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        uint256 id2 = _create(_named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        vm.prank(owner);
        escrow.setCreationPaused(true);

        CreateParams memory p = _named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days));
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.CreationIsPaused.selector);
        escrow.create(p);

        escrow.claim(id, recipient, _claimSig(linkPk, id, recipient)); // claim works while paused
        vm.warp(T0 + 1 days);
        escrow.settle(id, "", false); // settle works while paused
        assertTrue(_status(id) == Status.RELEASED, "released while paused");
        vm.warp(T0 + 3 days);
        escrow.refund(id2, false, false); // never settled before expiry -> refund, even while paused
        assertTrue(_status(id2) == Status.RETURNED, "refund works while paused");
    }

    function test_OwnerHasNoPathToEscrowedFunds() public {
        _create(_named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        uint256 held = usdg.balanceOf(address(escrow));
        vm.startPrank(owner);
        escrow.setFees(5e6, 5e6);
        escrow.setCreationPaused(true);
        escrow.transferOwnership(attacker);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(escrow)), held, "admin actions never move escrowed USDG");
        vm.prank(owner);
        vm.expectRevert(IIfsoEscrow.FeeTooHigh.selector);
        escrow.setFees(5e6 + 1, 0);
        vm.prank(attacker);
        vm.expectRevert(bytes4(keccak256("NotOwner()")));
        escrow.setFees(0, 0);
    }

    // ------------------------------------------------------------- deposits
    function test_CreateWithAuthorization_GaslessRelay() public {
        CreateParams memory p = _named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days));
        uint256 total = uint256(p.amount) + FEE;
        bytes32 nonce = escrow.createAuthNonce(sender, p);
        bytes memory auth = _usdgAuthSig(senderPk, sender, address(escrow), total, T0 - 1, T0 + 1 hours, nonce);
        vm.prank(keeper); // relayer
        uint256 id = escrow.createWithAuthorization(p, sender, T0 - 1, T0 + 1 hours, auth);
        assertEq(escrow.getEscrow(id).sender, sender, "sender is the authorizer, not the relayer");
        assertEq(usdg.balanceOf(address(router)), FEE, "fee routed");
    }

    function test_CreateWithAuthorization_TamperedParamsRevert() public {
        CreateParams memory p = _named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days));
        uint256 total = uint256(p.amount) + FEE;
        bytes memory auth =
            _usdgAuthSig(senderPk, sender, address(escrow), total, T0 - 1, T0 + 1 hours, escrow.createAuthNonce(sender, p));
        p.recipient = attacker; // relayer tries to re-point the payment
        vm.prank(attacker);
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        escrow.createWithAuthorization(p, sender, T0 - 1, T0 + 1 hours, auth);
    }

    function test_CreateWithPermit() public {
        vm.prank(sender);
        usdg.approve(address(escrow), 0);
        CreateParams memory p = _named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days));
        uint256 total = uint256(p.amount) + FEE;
        bytes32 sh = keccak256(abi.encode(usdg.PERMIT_TYPEHASH(), sender, address(escrow), total, 0, T0 + 1 hours));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(senderPk, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), sh)));
        vm.prank(sender);
        uint256 id = escrow.createWithPermit(p, T0 + 1 hours, v, r, s);
        assertTrue(_status(id) == Status.OPEN, "created via permit");
    }

    function test_CreateBatch_PayrollRun() public {
        CreateParams[] memory ps = new CreateParams[](3);
        for (uint256 i; i < 3; ++i) {
            ps[i] = _params(_time(uint64(T0 + 1 days)), address(uint160(0x5000 + i)), address(0), 100e6, uint64(T0 + 5 days));
        }
        vm.prank(sender);
        uint256[] memory ids = escrow.createBatch(ps);
        assertEq(usdg.balanceOf(address(escrow)), 300e6, "batch escrowed");
        assertEq(usdg.balanceOf(address(router)), 3 * uint256(FEE), "flat fee per payment");
        vm.warp(T0 + 1 days);
        for (uint256 i; i < 3; ++i) escrow.settle(ids[i], "", false);
        assertEq(usdg.balanceOf(address(0x5002)), 100e6, "paid");
    }

    // ------------------------------------------------------------- cancel
    function test_Cancel_OnlyWhenCancellable() public {
        uint256 locked = _create(_named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days)));
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.NotCancellable.selector);
        escrow.cancel(locked);

        CreateParams memory p = _named(_time(uint64(T0 + 1 days)), uint64(T0 + 3 days));
        p.cancellable = true;
        uint256 id = _create(p);
        vm.prank(attacker);
        vm.expectRevert(IIfsoEscrow.NotAuthorized.selector);
        escrow.cancel(id);
        vm.prank(sender);
        escrow.cancel(id);
        assertTrue(_status(id) == Status.CANCELLED, "cancelled");
    }

    // ------------------------------------------------------------- concessions
    function test_SenderOk_ReleasesEarly_RecipientDecline_Returns() public {
        uint256 a = _create(_named(_time(uint64(T0 + 10 days)), uint64(T0 + 12 days)));
        vm.prank(sender);
        escrow.approve(a);
        assertTrue(_status(a) == Status.RELEASED, "sender can always pay early");

        uint256 b = _create(_named(_time(uint64(T0 + 10 days)), uint64(T0 + 12 days)));
        vm.prank(recipient);
        escrow.decline(b);
        assertTrue(_status(b) == Status.RETURNED, "recipient can always hand it back");

        uint256 c = _create(_named(_time(uint64(T0 + 10 days)), uint64(T0 + 12 days)));
        vm.prank(recipient);
        escrow.approve(c); // recipient's own OK never releases outside PARTIES mode
        assertTrue(_status(c) == Status.OPEN, "still open");
    }

    // ------------------------------------------------------------- fuzz: exit is never gated
    function testFuzz_RefundAlwaysWorksAfterExpiry(uint96 amount, uint32 extra, bool paused, bool linkMode) public {
        amount = uint96(bound(amount, 1e6, 100_000e6));
        CreateParams memory p = _params(
            _time(uint64(T0 + 1 days)),
            linkMode ? address(0) : recipient,
            linkMode ? linkKey : address(0),
            amount,
            uint64(T0 + 2 days)
        );
        uint256 id = _create(p);
        if (paused) {
            vm.prank(owner);
            escrow.setCreationPaused(true);
        }
        vm.warp(T0 + 2 days + uint256(extra));
        uint256 sb = usdg.balanceOf(sender);
        escrow.refund(id, false, false);
        assertEq(usdg.balanceOf(sender) - sb, amount, "full refund");
    }
}
