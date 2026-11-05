// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../utils/IfsoFixture.sol";
import {IIfsoOutcomeResolver} from "../../src/interfaces/IIfsoOutcomeResolver.sol";
import {Owned2Step} from "../../src/utils/Owned2Step.sol";

/// Audit 2026-11-05 M-1 regression (was the PoC). A party that proposes and then disputes its own proposal used to
/// force any question to the panel at zero bond cost. Now:
///   - the same address cannot dispute its own proposal (SelfDispute);
///   - with TWO addresses (proposer A, disputer B, one owner), the attacker loses >= bond / 2 in every branch:
///     panel answers for the proposal, against it, VOID, or stays silent (each side then gets only bond / 2 back);
///   - the forfeited halves reach the FeeRouter, which splits them 80/10/5/5;
///   - the honest service (proposes truth, disputes wrong proposals) gains bond / 2 whenever the panel answers.
contract AuditM1SelfDisputePoC is IfsoFixture {
    bytes32 internal qid;
    uint64 internal kickoff;
    uint64 internal fullTime;
    uint256 internal constant HOME = 1 << 1;
    uint256 internal constant BOND = 100e6;
    address internal attacker2 = address(0xBAD2); // second address of the same attacker

    function setUp() public override {
        super.setUp();
        kickoff = uint64(T0 + 1 days - 3 hours);
        fullTime = uint64(T0 + 1 days);
        vm.prank(creator);
        qid = resolver.createQuestion(keccak256("EPL:ARS-CHE"), kickoff, fullTime, 3, "ipfs://spec");
        address[2] memory as_ = [attacker, attacker2];
        for (uint256 i; i < 2; ++i) {
            usdg.mint(as_[i], 1_000e6);
            vm.prank(as_[i]);
            usdg.approve(address(resolver), type(uint256).max);
        }
    }

    function _bal(address a) internal view returns (uint256) {
        return usdg.balanceOf(a) + resolver.claimableBond(a);
    }

    /// Both attacker addresses together (one owner).
    function _both() internal view returns (uint256) {
        return _bal(attacker) + _bal(attacker2);
    }

    /// The attacker proposes a wrong answer from `attacker` and disputes it from `attacker2` in the same block.
    function _selfDisputeTwoAddresses(uint8 proposed) internal {
        vm.warp(fullTime);
        vm.prank(attacker);
        resolver.propose(qid, proposed, bytes32("A"));
        vm.prank(attacker2);
        resolver.dispute(qid, bytes32("B"));
    }

    // ---------------------------------------------------------------- same address
    function test_SelfDispute_SameAddressRefused() public {
        vm.warp(fullTime);
        vm.startPrank(attacker);
        resolver.propose(qid, 3, bytes32("wrong: DRAW"));
        vm.expectRevert(IfsoOutcomeResolver.SelfDispute.selector);
        resolver.dispute(qid, bytes32("self"));
        vm.stopPrank();
        // the question stays PROPOSED, so the honest service can still dispute it
        vm.prank(keeper);
        resolver.dispute(qid, bytes32("odds+sportsdb"));
        (IIfsoOutcomeResolver.State st,) = resolver.outcomeOf(qid);
        assertTrue(st == IIfsoOutcomeResolver.State.DISPUTED, "service dispute accepted");
    }

    // ---------------------------------------------------------------- two addresses, every branch
    /// Panel rules against the attacker's proposal (truth = HOME): the payment is released and A+B lose bond / 2.
    function test_SelfDispute_TwoAddresses_PanelAgainstProposal_CostsHalfBond() public {
        uint256 id = _create(_named(_outcome(qid, HOME), uint64(T0 + 10 days)));
        uint256 before = _both();
        _selfDisputeTwoAddresses(3);
        vm.warp(fullTime + 70 hours);
        vm.prank(panel);
        resolver.panelResolve(qid, 1);
        escrow.settle(id, "", false);
        assertTrue(_status(id) == Status.RELEASED, "recipient paid");
        assertGe(before - _both(), BOND / 2, "self-dispute costs at least bond / 2");
        assertEq(resolver.forfeited(), BOND / 2, "loser's other half is held for the FeeRouter");
    }

    /// Panel agrees with the attacker's proposal: still bond / 2.
    function test_SelfDispute_TwoAddresses_PanelForProposal_CostsHalfBond() public {
        uint256 before = _both();
        _selfDisputeTwoAddresses(1);
        vm.prank(panel);
        resolver.panelResolve(qid, 1);
        assertGe(before - _both(), BOND / 2, "self-dispute costs at least bond / 2");
    }

    /// Panel answers VOID (outcome 0): the disputer side wins, still bond / 2.
    function test_SelfDispute_TwoAddresses_PanelVoid_CostsHalfBond() public {
        uint256 before = _both();
        _selfDisputeTwoAddresses(1);
        vm.prank(panel);
        resolver.panelResolve(qid, 0);
        assertGe(before - _both(), BOND / 2, "self-dispute costs at least bond / 2");
    }

    /// Panel silent: the question VOIDs, each side gets only bond / 2 back, so A+B lose a whole bond.
    function test_SelfDispute_TwoAddresses_PanelSilent_CostsBond() public {
        uint256 id = _create(_named(_outcome(qid, HOME), uint64(T0 + 10 days)));
        uint256 before = _both();
        _selfDisputeTwoAddresses(3);
        vm.warp(fullTime + 72 hours);
        resolver.finalizeTimedOut(qid);
        escrow.settle(id, "", false);
        assertTrue(_status(id) == Status.RETURNED, "VOID -> returned");
        assertGe(before - _both(), BOND / 2, "silence still costs at least bond / 2");
        assertEq(before - _both(), BOND, "silence costs both halves");
        assertEq(resolver.forfeited(), BOND, "both halves held for the FeeRouter");
    }

    /// Fuzz: any bond the owner may set, any panel answer or silence: A+B lose >= bond / 2 (rounded down).
    function testFuzz_SelfDispute_TwoAddresses_AlwaysCostsHalfBond(uint96 bondSeed, uint8 answer, bool silent) public {
        uint96 bond = uint96(10e6 + uint256(bondSeed) % (10_000e6 - 10e6 + 1));
        vm.prank(owner);
        resolver.setBondAmount(bond);
        usdg.mint(attacker, bond);
        usdg.mint(attacker2, bond);
        uint256 before = _both();
        _selfDisputeTwoAddresses(1);
        if (silent) {
            vm.warp(fullTime + 72 hours);
            resolver.finalizeTimedOut(qid);
        } else {
            vm.prank(panel);
            resolver.panelResolve(qid, answer % 4);
        }
        assertGe(before - _both(), uint256(bond) / 2, "attacker loses >= bond / 2");
        assertEq(before - _both(), resolver.forfeited(), "everything the attacker lost is held for the FeeRouter");
    }

    /// Odd bond: the loser's forfeited half rounds UP (never below bond / 2); silence forfeits both rounded-up halves.
    function test_OddBond_ForfeitRoundsUp() public {
        vm.prank(owner);
        resolver.setBondAmount(10_000_001);
        _selfDisputeTwoAddresses(1);
        vm.prank(panel);
        resolver.panelResolve(qid, 2);
        assertEq(resolver.forfeited(), 5_000_001, "panel: ceil(bond / 2) forfeited");
        assertEq(resolver.claimableBond(attacker2), 15_000_001, "winner: own bond + floor half of the loser's");

        vm.prank(creator);
        bytes32 q2 = resolver.createQuestion(keccak256("q2"), fullTime + 1, fullTime + 2, 3, "");
        vm.warp(fullTime + 2);
        vm.prank(attacker);
        resolver.propose(q2, 1, bytes32(0));
        vm.prank(attacker2);
        resolver.dispute(q2, bytes32(0));
        vm.warp(block.timestamp + 72 hours);
        resolver.finalizeTimedOut(q2);
        assertEq(resolver.forfeited(), 5_000_001 + 10_000_002, "silence: two ceil halves forfeited");
        assertEq(resolver.claimableBond(attacker), 5_000_000, "silence: proposer floor half back");
    }

    function test_Constructor_ZeroFeeRouterRefused() public {
        vm.expectRevert(Owned2Step.ZeroAddress.selector);
        new IfsoOutcomeResolver(owner, address(usdg), 2 hours, 72 hours, 100e6, panel, address(0));
    }

    // ---------------------------------------------------------------- FeeRouter inflow
    function test_Forfeits_ForwardedToFeeRouter_AndSplit() public {
        _selfDisputeTwoAddresses(3);
        vm.prank(panel);
        resolver.panelResolve(qid, 1);
        uint256 f = resolver.forfeited();
        uint256 rBefore = usdg.balanceOf(address(router));
        vm.prank(attacker); // permissionless
        resolver.forwardForfeits();
        assertEq(resolver.forfeited(), 0, "cleared");
        assertEq(usdg.balanceOf(address(router)) - rBefore, f, "router received the forfeits");
        vm.expectRevert(IfsoOutcomeResolver.NothingToWithdraw.selector);
        resolver.forwardForfeits();
        router.distribute();
        assertEq(usdg.balanceOf(address(0xF1)), (f * 8000) / 10_000, "80% to work (funds resolver bonds)");
    }

    // ---------------------------------------------------------------- honest service stays solvent
    /// The service disputes a wrong foreign proposal and the panel agrees: it gains bond / 2.
    function test_Service_DisputesWrongProposal_GainsHalfBond() public {
        uint256 before = _bal(keeper);
        vm.warp(fullTime);
        vm.prank(attacker);
        resolver.propose(qid, 3, bytes32("wrong"));
        vm.prank(keeper);
        resolver.dispute(qid, bytes32("odds+sportsdb"));
        vm.prank(panel);
        resolver.panelResolve(qid, 1);
        assertEq(_bal(keeper) - before, BOND / 2, "service +bond/2");
    }

    /// A griefer disputes the service's correct proposal and the panel agrees with the service: +bond / 2.
    function test_Service_GriefedProposal_GainsHalfBond() public {
        uint256 before = _bal(keeper);
        uint256 aBefore = _bal(attacker);
        vm.warp(fullTime);
        vm.prank(keeper);
        resolver.propose(qid, 1, bytes32("odds+sportsdb"));
        vm.prank(attacker);
        resolver.dispute(qid, bytes32(0));
        vm.prank(panel);
        resolver.panelResolve(qid, 1);
        assertEq(_bal(keeper) - before, BOND / 2, "service +bond/2");
        assertEq(aBefore - _bal(attacker), BOND, "independent wrong disputer still loses a whole bond");
    }

    /// Control: the documented deterrent works for an independent disputer (keeper proposes HOME, attacker disputes,
    /// panel says HOME): the disputer forfeits its whole bond.
    function test_Control_IndependentWrongDisputerLosesBond() public {
        uint256 id = _create(_named(_outcome(qid, HOME), uint64(T0 + 10 days)));
        uint256 before = _bal(attacker);
        vm.warp(fullTime);
        vm.prank(keeper);
        resolver.propose(qid, 1, bytes32("odds+sportsdb"));
        vm.prank(attacker);
        resolver.dispute(qid, bytes32(0));
        vm.warp(fullTime + 1 hours);
        vm.prank(panel);
        resolver.panelResolve(qid, 1);
        escrow.settle(id, "", false);
        assertTrue(_status(id) == Status.RELEASED, "released");
        assertEq(before - _bal(attacker), 100e6, "independent wrong disputer loses one bond");
    }
}
