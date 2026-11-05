// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./utils/IfsoFixture.sol";
import {IIfsoOutcomeResolver} from "../src/interfaces/IIfsoOutcomeResolver.sol";

contract OutcomeResolverTest is IfsoFixture {
    // outcomes: 0 VOID, 1 HOME (Arsenal), 2 AWAY, 3 DRAW
    bytes32 internal qid;
    uint64 internal kickoffPlus;
    uint64 internal kickoff;
    uint256 internal constant HOME = 1 << 1;

    function setUp() public override {
        super.setUp();
        kickoffPlus = uint64(T0 + 1 days); // full time + buffer
        vm.prank(creator);
        kickoff = uint64(T0 + 1 days - 3 hours);
        qid = resolver.createQuestion(
            keccak256("EPL:ARS-CHE:2026-09-22:90min+stoppage"), kickoff, kickoffPlus, 3, "ipfs://spec"
        );
    }

    function _escrowOnHome() internal returns (uint256) {
        return _create(_named(_outcome(qid, HOME), uint64(T0 + 10 days)));
    }

    function test_ResolverFeeChargedForOutcome() public {
        _escrowOnHome();
        assertEq(usdg.balanceOf(address(router)), FEE + RFEE, "creation + resolver fee");
    }

    function test_Undisputed_Finalize_Settles() public {
        uint256 id = _escrowOnHome();
        vm.prank(keeper);
        vm.expectRevert(IfsoOutcomeResolver.TooEarly.selector);
        resolver.propose(qid, 1, keccak256("sources"));

        vm.warp(kickoffPlus);
        vm.prank(keeper);
        resolver.propose(qid, 1, keccak256("odds-api+second-source"));
        vm.expectRevert(IIfsoEscrow.ConditionPending.selector);
        escrow.settle(id, "", false);

        vm.expectRevert(IfsoOutcomeResolver.TooEarly.selector);
        resolver.finalize(qid);
        vm.warp(kickoffPlus + 2 hours);
        resolver.finalize(qid);
        escrow.settle(id, "", false);
        assertTrue(_status(id) == Status.RELEASED, "released on HOME");

        uint256 kb = usdg.balanceOf(keeper);
        vm.prank(keeper);
        resolver.withdrawBond(address(0));
        assertEq(usdg.balanceOf(keeper) - kb, 100e6, "bond returned");
    }

    function test_OtherOutcome_Returns() public {
        uint256 id = _escrowOnHome();
        vm.warp(kickoffPlus);
        vm.prank(keeper);
        resolver.propose(qid, 3, bytes32(0)); // DRAW
        vm.warp(kickoffPlus + 2 hours);
        resolver.finalize(qid);
        escrow.settle(id, "", false);
        assertTrue(_status(id) == Status.RETURNED, "returned on DRAW");
    }

    function test_VoidOutcome_Refunds() public {
        uint256 id = _escrowOnHome();
        vm.warp(kickoffPlus);
        vm.prank(keeper);
        resolver.propose(qid, 0, bytes32(0)); // postponed
        vm.warp(kickoffPlus + 2 hours);
        resolver.finalize(qid);
        escrow.settle(id, "", false);
        assertTrue(_status(id) == Status.RETURNED, "VOID refunds");
    }

    function test_Dispute_PanelSidesWithDisputer() public {
        uint256 id = _escrowOnHome();
        vm.warp(kickoffPlus);
        vm.prank(keeper);
        resolver.propose(qid, 2, bytes32(0)); // wrong: AWAY
        vm.prank(recipient);
        resolver.dispute(qid, keccak256("evidence"));
        vm.prank(attacker);
        vm.expectRevert(IfsoOutcomeResolver.NotPanel.selector);
        resolver.panelResolve(qid, 1);
        vm.prank(panel);
        resolver.panelResolve(qid, 1);
        escrow.settle(id, "", false);
        assertTrue(_status(id) == Status.RELEASED, "panel outcome HOME");
        assertEq(resolver.claimableBond(recipient), 150e6, "disputer: own bond + half the proposer's (M-1)");
        assertEq(resolver.claimableBond(keeper), 0, "losing proposer gets nothing");
        assertEq(resolver.forfeited(), 50e6, "other half forfeited to the FeeRouter");
    }

    function test_Dispute_AfterWindowReverts() public {
        vm.warp(kickoffPlus);
        vm.prank(keeper);
        resolver.propose(qid, 1, bytes32(0));
        vm.warp(kickoffPlus + 2 hours);
        vm.prank(recipient);
        vm.expectRevert(IfsoOutcomeResolver.WindowClosed.selector);
        resolver.dispute(qid, bytes32(0));
    }

    function test_PanelTimeout_VoidsAndHalfBondsReturn_TwoSidedVoided() public {
        CreateParams memory p = _params(_outcome(qid, HOME), recipient, address(0), 20e6, uint64(T0 + 10 days));
        p.twoSided = true;
        p.counterAmount = 30e6;
        p.acceptBy = uint64(T0 + 12 hours);
        uint256 id = _create(p);
        vm.prank(recipient);
        escrow.accept(id, "", address(0));

        vm.warp(kickoffPlus);
        vm.prank(keeper);
        resolver.propose(qid, 1, bytes32(0));
        vm.prank(attacker);
        vm.expectRevert(); // attacker has no USDG/allowance for the bond
        resolver.dispute(qid, bytes32(0));
        vm.prank(recipient);
        resolver.dispute(qid, bytes32(0));
        vm.warp(kickoffPlus + 72 hours);
        resolver.finalizeTimedOut(qid);
        (IIfsoOutcomeResolver.State st,) = resolver.outcomeOf(qid);
        assertTrue(st == IIfsoOutcomeResolver.State.VOID, "void");

        uint256 sb = usdg.balanceOf(sender);
        uint256 rb = usdg.balanceOf(recipient);
        escrow.settle(id, "", false);
        assertEq(usdg.balanceOf(sender) - sb, 20e6, "sender own stake");
        assertEq(usdg.balanceOf(recipient) - rb, 30e6, "acceptor own stake");
        assertEq(resolver.claimableBond(keeper), 50e6, "proposer half bond back (M-1)");
        assertEq(resolver.claimableBond(recipient), 50e6, "disputer half bond back (M-1)");
        assertEq(resolver.forfeited(), 100e6, "both other halves forfeited to the FeeRouter");
    }

    function test_Validate_OutcomeMaskAndExpiry() public {
        CreateParams memory p = _named(_outcome(qid, 1), uint64(T0 + 10 days)); // bit 0 = VOID
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);

        p = _named(_outcome(qid, 1 << 4), uint64(T0 + 10 days)); // beyond numOutcomes
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);

        p = _named(_outcome(qid, HOME), uint64(kickoffPlus + 1 hours)); // no room for dispute + claim
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);

        p = _named(_outcome(keccak256("unknown"), HOME), uint64(T0 + 10 days));
        vm.prank(sender);
        vm.expectRevert(IfsoConditionEvaluator.InvalidCondition.selector);
        escrow.create(p);
    }

    function test_OnlyCreatorsRegisterQuestions_PanelChangeDelayed() public {
        vm.prank(attacker);
        vm.expectRevert(IfsoOutcomeResolver.NotCreator.selector);
        resolver.createQuestion(keccak256("x"), uint64(T0 + 1 days), uint64(T0 + 1 days), 2, "");

        vm.prank(owner);
        resolver.queuePanel(attacker);
        vm.expectRevert(IfsoOutcomeResolver.TooEarly.selector);
        resolver.applyPanel();
        vm.warp(T0 + 48 hours);
        resolver.applyPanel();
        assertEq(resolver.panel(), attacker, "panel rotated after delay");
    }

    function test_BondBounds() public {
        vm.prank(owner);
        vm.expectRevert(IfsoOutcomeResolver.BondOutOfBounds.selector);
        resolver.setBondAmount(1e6);
    }
}
