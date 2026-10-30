// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./utils/IfsoFixture.sol";
import {MockERC1271Wallet} from "../src/mocks/MockERC1271Wallet.sol";

contract ApproveConditionsTest is IfsoFixture {
    function test_Parties_NeedsBothOks() public {
        uint256 id = _create(_named(_parties(), uint64(T0 + 7 days)));
        vm.prank(sender);
        escrow.approve(id);
        assertTrue(_status(id) == Status.OPEN, "sender OK alone does not release in PARTIES mode");
        vm.prank(recipient);
        escrow.approve(id);
        assertTrue(_status(id) == Status.RELEASED, "both OK releases");
    }

    function test_Parties_OrderDoesNotMatter_AndStrangersRejected() public {
        uint256 id = _create(_named(_parties(), uint64(T0 + 7 days)));
        vm.prank(attacker);
        vm.expectRevert(IIfsoEscrow.NotAuthorized.selector);
        escrow.approve(id);
        vm.prank(recipient);
        escrow.approve(id);
        vm.prank(sender);
        escrow.approve(id);
        assertTrue(_status(id) == Status.RELEASED, "released");
    }

    function test_Parties_RecipientDeclineReturns_SenderCannotSelfRefund() public {
        uint256 id = _create(_named(_parties(), uint64(T0 + 7 days)));
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.NotAuthorized.selector);
        escrow.decline(id);
        vm.prank(recipient);
        escrow.decline(id);
        assertTrue(_status(id) == Status.RETURNED, "returned on recipient decline");
    }

    function test_Parties_SettleNotAllowed() public {
        uint256 id = _create(_named(_parties(), uint64(T0 + 7 days)));
        vm.expectRevert(IIfsoEscrow.UseDecision.selector);
        escrow.settle(id, "", false);
    }

    function test_Referee_OnlyTwoPaths() public {
        uint256 a = _create(_named(_referee(referee), uint64(T0 + 7 days)));
        vm.prank(attacker);
        vm.expectRevert(IIfsoEscrow.NotAuthorized.selector);
        escrow.refereeDecide(a, true);
        vm.prank(referee);
        escrow.refereeDecide(a, true);
        assertEq(usdg.balanceOf(recipient), 1_000_000e6 + 20e6, "to recipient");

        uint256 b = _create(_named(_referee(referee), uint64(T0 + 7 days)));
        uint256 sb = usdg.balanceOf(sender);
        vm.prank(referee);
        escrow.refereeDecide(b, false);
        assertEq(usdg.balanceOf(sender) - sb, 20e6, "back to sender");
        assertEq(usdg.balanceOf(referee), 0, "referee never receives funds");
    }

    function test_Referee_CannotBeSenderOrRecipient() public {
        CreateParams memory p = _named(_referee(sender), uint64(T0 + 7 days));
        vm.prank(sender);
        vm.expectRevert(IIfsoEscrow.InvalidParams.selector);
        escrow.create(p);
    }

    function test_Referee_LinkUnclaimed_ReleaseMarksMet() public {
        uint256 id = _create(_link(_referee(referee), uint64(T0 + 7 days)));
        vm.prank(referee);
        escrow.refereeDecide(id, true);
        assertTrue(_status(id) == Status.MET, "met until the link is claimed");
        bytes memory toReferee = _claimSig(linkPk, id, referee);
        vm.expectRevert(IIfsoEscrow.BadRecipient.selector); // referee cannot claim it to itself
        escrow.claim(id, referee, toReferee);
        escrow.claim(id, recipient, _claimSig(linkPk, id, recipient));
        assertTrue(_status(id) == Status.RELEASED, "released on claim");
    }

    function test_DecideBySig_Eoa_And_Replay() public {
        uint256 id = _create(_params(_parties(), recipientEoa, address(0), 20e6, uint64(T0 + 7 days)));
        uint256 deadline = T0 + 1 hours;
        bytes memory s1 = _sig(senderPk, escrow.hashDecision(id, 1, 0, deadline));
        vm.prank(keeper);
        escrow.decideBySig(id, sender, 1, deadline, s1);
        vm.expectRevert(IIfsoEscrow.BadSignature.selector);
        escrow.decideBySig(id, sender, 1, deadline, s1); // nonce consumed
        bytes memory s2 = _sig(recipientPk, escrow.hashDecision(id, 1, 0, deadline));
        escrow.decideBySig(id, recipientEoa, 1, deadline, s2);
        assertTrue(_status(id) == Status.RELEASED, "both OK by relayed signatures");
    }

    function test_DecideBySig_SmartAccountReferee_1271() public {
        uint256 refPk = 0x5EF;
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(refPk));
        uint256 id = _create(_named(_referee(address(wallet)), uint64(T0 + 7 days)));
        uint256 deadline = T0 + 1 hours;
        bytes memory sig = _sig(refPk, escrow.hashDecision(id, 4, 0, deadline)); // REFEREE_RETURN
        escrow.decideBySig(id, address(wallet), 4, deadline, sig);
        assertTrue(_status(id) == Status.RETURNED, "1271 referee decision");
    }

    function test_DecideBySig_Expired() public {
        uint256 id = _create(_named(_parties(), uint64(T0 + 7 days)));
        bytes memory s1 = _sig(senderPk, escrow.hashDecision(id, 1, 0, T0 + 1));
        vm.warp(T0 + 2);
        vm.expectRevert(IIfsoEscrow.SignatureExpired.selector);
        escrow.decideBySig(id, sender, 1, T0 + 1, s1);
    }

    function test_Decisions_AfterExpiry_OnlyRefund() public {
        uint256 id = _create(_named(_referee(referee), uint64(T0 + 7 days)));
        vm.warp(T0 + 7 days);
        vm.prank(referee);
        vm.expectRevert(IIfsoEscrow.Expired.selector);
        escrow.refereeDecide(id, true);
        escrow.refund(id, false, false);
        assertTrue(_status(id) == Status.RETURNED, "refund");
    }
}
