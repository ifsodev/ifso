// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase, Vm} from "../utils/TestBase.sol";
import {IfsoOutcomeResolver} from "../../src/IfsoOutcomeResolver.sol";
import {IIfsoOutcomeResolver} from "../../src/interfaces/IIfsoOutcomeResolver.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";

/// @notice Drives IfsoOutcomeResolver through every path: create, propose, dispute, finalize, panel answer, panel
///         time-out, bond withdraw (to self and to another address), owner bond changes between a proposal and its
///         dispute, stray USDG donations, time warps, self-disputes (proposer == disputer, audit M-1) and forwarding
///         forfeited bond halves to the FeeRouter. Every success updates ghost books written from the spec
///         (contract header), never from the contract's own storage, so the invariants compare two independent
///         accounts.
contract ResolverHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant MAX_Q = 48;

    IfsoOutcomeResolver public immutable resolver;
    MockUSDG public immutable usdg;
    address public immutable owner;
    address public immutable creator;
    address public immutable panel;
    address[4] public actors;
    address public constant SINK = address(0x5111C); // withdraw destination that is not an actor

    bytes32[] public qs;
    mapping(bytes32 => uint8) public seenState; // last state the handler observed (for the forward-only check)
    mapping(address => uint256) public expectedCredit; // what each actor must have been credited, per the spec
    mapping(address => uint256) public withdrawnBy; // claimable each actor took out
    uint256 public totalCreditedSpec; // sum of the pots of every question that reached FINAL / VOID
    uint256 public totalWithdrawn;
    uint256 public donated;
    bool public backwardsMove; // set if any call moved a question to an earlier state or out of a terminal one
    uint256 public bondsIn;
    mapping(bytes32 => bool) public resolvedOnce; // a terminal call (finalize / panel / time-out) succeeded
    bool public secondCredit; // a second terminal call on the same question succeeded
    uint256 public forfeitedSpec; // forfeited halves per the spec (panel: loser's ceil half; silence: both ceil halves)
    uint256 public forwarded; // forfeits forwarded to the FeeRouter
    bool public selfDisputed; // a dispute from the proposer's own address succeeded (M-1)
    bool public cheapDispute; // a disputed question resolved with less than bond / 2 forfeited (M-1)
    uint256 public nSelfDisputeRefused;
    uint256 public nForward;

    function _resolved(bytes32 id) internal {
        if (resolvedOnce[id]) secondCredit = true;
        resolvedOnce[id] = true;
    }

    // path counters (test_ResolverHandlerReachesEveryPath)
    uint256 public nCreate;
    uint256 public nPropose;
    uint256 public nDispute;
    uint256 public nFinalize;
    uint256 public nPanelProposer;
    uint256 public nPanelDisputer;
    uint256 public nTimeout;
    uint256 public nWithdraw;
    uint256 public nSetBond;

    constructor(IfsoOutcomeResolver r, MockUSDG u, address owner_, address creator_, address panel_) {
        resolver = r;
        usdg = u;
        owner = owner_;
        creator = creator_;
        panel = panel_;
        for (uint256 i; i < 4; ++i) {
            address a = address(uint160(0xA0000 + i));
            actors[i] = a;
            u.mint(a, 1e15);
            vm.prank(a);
            u.approve(address(r), type(uint256).max);
        }
    }

    function qCount() external view returns (uint256) {
        return qs.length;
    }

    function _q(uint256 seed) internal view returns (bytes32 id, bool ok) {
        if (qs.length == 0) return (bytes32(0), false);
        return (qs[seed % qs.length], true);
    }

    function _rank(uint8 s) internal pure returns (uint8) {
        return s; // NONE < OPEN < PROPOSED < DISPUTED < FINAL/VOID (enum order is the lifecycle order)
    }

    /// @dev Allowed edges: NONE->OPEN->PROPOSED->{FINAL,DISPUTED}, DISPUTED->{FINAL,VOID}. Terminal states never move.
    function _observe(bytes32 id) internal {
        (IIfsoOutcomeResolver.State st,) = resolver.outcomeOf(id);
        uint8 now_ = uint8(st);
        uint8 was = seenState[id];
        if (now_ != was) {
            bool ok = (was == 0 && now_ == 1) || (was == 1 && now_ == 2) || (was == 2 && (now_ == 3 || now_ == 4))
                || (was == 3 && (now_ == 4 || now_ == 5));
            if (!ok) backwardsMove = true;
        }
        seenState[id] = now_;
    }

    function _observeAll() internal {
        for (uint256 i; i < qs.length; ++i) {
            _observe(qs[i]);
        }
    }

    // ------------------------------------------------------------------ actions
    function create(uint256 seed, uint8 outcomes, uint32 closeIn, uint32 resolveAfter) external {
        if (qs.length >= MAX_Q) return;
        uint64 close = uint64(block.timestamp) + 1 + uint64(closeIn % 3 days);
        uint64 earliest = close + uint64(resolveAfter % 6 hours);
        uint8 n = uint8(2 + (outcomes % 4));
        bytes32 spec = keccak256(abi.encode(seed, qs.length));
        vm.prank(creator);
        try resolver.createQuestion(spec, close, earliest, n, "ipfs://spec") returns (bytes32 id) {
            qs.push(id);
            ++nCreate;
            _observe(id);
        } catch {}
        _observeAll();
    }

    function propose(uint256 qSeed, uint256 actorSeed, uint8 outcome, bool jump) external {
        (bytes32 id, bool ok) = _q(qSeed);
        if (!ok) return;
        IfsoOutcomeResolver.Question memory q = resolver.getQuestion(id);
        if (jump && block.timestamp < q.earliestResolve) vm.warp(q.earliestResolve);
        address a = actors[actorSeed % 4];
        uint8 o = uint8(outcome % (q.numOutcomes + 1));
        uint256 bal = usdg.balanceOf(address(resolver));
        vm.prank(a);
        try resolver.propose(id, o, keccak256("sources")) {
            ++nPropose;
            bondsIn += usdg.balanceOf(address(resolver)) - bal;
        } catch {}
        _observeAll();
    }

    function dispute(uint256 qSeed, uint256 actorSeed) external {
        (bytes32 id, bool ok) = _q(qSeed);
        if (!ok) return;
        address a = actors[actorSeed % 4];
        address p = resolver.getQuestion(id).proposer;
        uint256 bal = usdg.balanceOf(address(resolver));
        vm.prank(a);
        try resolver.dispute(id, keccak256("evidence")) {
            ++nDispute;
            if (a == p) selfDisputed = true;
            bondsIn += usdg.balanceOf(address(resolver)) - bal;
        } catch {}
        _observeAll();
    }

    /// @dev M-1: the proposer itself tries to dispute its own live proposal (inside the window).
    function selfDispute(uint256 qSeed) external {
        (bytes32 id, bool ok) = _q(qSeed);
        if (!ok) return;
        IfsoOutcomeResolver.Question memory q = resolver.getQuestion(id);
        if (q.state != IIfsoOutcomeResolver.State.PROPOSED) return;
        if (block.timestamp >= uint256(q.proposedAt) + resolver.disputeWindow()) return;
        vm.prank(q.proposer);
        try resolver.dispute(id, keccak256("self")) {
            selfDisputed = true;
        } catch {
            ++nSelfDisputeRefused;
        }
        _observeAll();
    }

    function forward() external {
        uint256 f = resolver.forfeited();
        try resolver.forwardForfeits() {
            ++nForward;
            forwarded += f;
        } catch {}
    }

    function finalize(uint256 qSeed, bool jump) external {
        (bytes32 id, bool ok) = _q(qSeed);
        if (!ok) return;
        IfsoOutcomeResolver.Question memory q = resolver.getQuestion(id);
        uint256 due = uint256(q.proposedAt) + resolver.disputeWindow();
        if (jump && q.state == IIfsoOutcomeResolver.State.PROPOSED && block.timestamp < due) vm.warp(due);
        try resolver.finalize(id) {
            ++nFinalize;
            _resolved(id);
            expectedCredit[q.proposer] += q.bond;
            totalCreditedSpec += q.bond;
        } catch {}
        _observeAll();
    }

    function panelResolve(uint256 qSeed, uint8 outcome, bool agree) external {
        (bytes32 id, bool ok) = _q(qSeed);
        if (!ok) return;
        IfsoOutcomeResolver.Question memory q = resolver.getQuestion(id);
        uint8 o = agree ? q.proposed : uint8(outcome % (q.numOutcomes + 1));
        uint256 f0 = resolver.forfeited();
        vm.prank(panel);
        try resolver.panelResolve(id, o) {
            if (resolver.forfeited() - f0 < q.bond / 2) cheapDispute = true; // measured on the contract
            _resolved(id);
            uint256 lost = (uint256(q.bond) + 1) / 2; // the loser's forfeited half, rounded up
            uint256 pot = uint256(q.bond) * 2 - lost; // winner: own bond + the loser's other half
            if (o == q.proposed) {
                expectedCredit[q.proposer] += pot;
                ++nPanelProposer;
            } else {
                expectedCredit[q.disputer] += pot;
                ++nPanelDisputer;
            }
            totalCreditedSpec += pot;
            forfeitedSpec += lost;
        } catch {}
        _observeAll();
    }

    function timeout(uint256 qSeed, bool jump) external {
        (bytes32 id, bool ok) = _q(qSeed);
        if (!ok) return;
        IfsoOutcomeResolver.Question memory q = resolver.getQuestion(id);
        uint256 due = uint256(q.disputedAt) + resolver.panelWindow();
        if (jump && q.state == IIfsoOutcomeResolver.State.DISPUTED && block.timestamp < due) vm.warp(due);
        uint256 f0 = resolver.forfeited();
        try resolver.finalizeTimedOut(id) {
            if (resolver.forfeited() - f0 < q.bond / 2) cheapDispute = true; // measured on the contract
            ++nTimeout;
            _resolved(id);
            uint256 back = uint256(q.bond) / 2; // each side gets half its bond back
            expectedCredit[q.proposer] += back;
            expectedCredit[q.disputer] += back;
            totalCreditedSpec += back * 2;
            forfeitedSpec += uint256(q.bond) * 2 - back * 2;
        } catch {}
        _observeAll();
    }

    function withdraw(uint256 actorSeed, bool toSink) external {
        address a = actors[actorSeed % 4];
        uint256 c = resolver.claimableBond(a);
        vm.prank(a);
        try resolver.withdrawBond(toSink ? SINK : address(0)) {
            ++nWithdraw;
            withdrawnBy[a] += c;
            totalWithdrawn += c;
        } catch {}
        _observeAll();
    }

    function setBond(uint96 bond) external {
        uint96 b = uint96(10e6 + (uint256(bond) % (10_000e6 - 10e6 + 1)));
        vm.prank(owner);
        resolver.setBondAmount(b);
        ++nSetBond;
    }

    function donate(uint64 amount) external {
        uint256 a = uint256(amount) % 1_000e6;
        usdg.mint(address(resolver), a);
        donated += a;
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + (uint256(dt) % 4 days));
        _observeAll();
    }
}

/// @notice Handler-based invariants for IfsoOutcomeResolver (contracts/INVARIANTS.md, OR1-OR4).
///         Default profile: a quick pass. `FOUNDRY_PROFILE=invariant`: 10,000 runs x depth 50.
contract ResolverInvariantsTest is TestBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    MockUSDG internal usdg;
    IfsoOutcomeResolver internal resolver;
    ResolverHandler internal handler;
    address internal constant OWNER = address(0x0E1);
    address internal constant CREATOR = address(0xC0E);
    address internal constant PANEL = address(0x9A9E1);
    address internal constant FEE_ROUTER = address(0xFEE5);

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        resolver = new IfsoOutcomeResolver(OWNER, address(usdg), 2 hours, 72 hours, 100e6, PANEL, FEE_ROUTER);
        handler = new ResolverHandler(resolver, usdg, OWNER, CREATOR, PANEL);
        vm.prank(OWNER);
        resolver.setCreator(CREATOR, true);
    }

    /// @dev forge-std-compatible discovery hooks (this repo vendors no forge-std).
    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory s) {
        bytes4[] memory sel = new bytes4[](15);
        sel[0] = ResolverHandler.create.selector;
        sel[1] = ResolverHandler.propose.selector;
        sel[2] = ResolverHandler.dispute.selector;
        sel[3] = ResolverHandler.finalize.selector;
        sel[4] = ResolverHandler.panelResolve.selector;
        sel[5] = ResolverHandler.timeout.selector;
        sel[6] = ResolverHandler.withdraw.selector;
        sel[7] = ResolverHandler.setBond.selector;
        sel[8] = ResolverHandler.donate.selector;
        sel[9] = ResolverHandler.warp.selector;
        sel[10] = ResolverHandler.create.selector; // weighted: runs hold many questions
        sel[11] = ResolverHandler.propose.selector;
        sel[12] = ResolverHandler.dispute.selector;
        sel[13] = ResolverHandler.selfDispute.selector;
        sel[14] = ResolverHandler.forward.selector;
        s = new FuzzSelector[](1);
        s[0] = FuzzSelector(address(handler), sel);
    }

    function _sumClaimable() internal view returns (uint256 sum) {
        for (uint256 i; i < 4; ++i) {
            sum += resolver.claimableBond(handler.actors(i));
        }
    }

    function _sumLive() internal view returns (uint256 live) {
        uint256 n = handler.qCount();
        for (uint256 i; i < n; ++i) {
            IfsoOutcomeResolver.Question memory q = resolver.getQuestion(handler.qs(i));
            if (q.state == IIfsoOutcomeResolver.State.PROPOSED) live += q.bond;
            else if (q.state == IIfsoOutcomeResolver.State.DISPUTED) live += uint256(q.bond) * 2;
        }
    }

    /// @notice OR1: the resolver's USDG balance equals every claimable bond plus every live bond (one bond for a
    ///         PROPOSED question, two for a DISPUTED one), plus forfeits not yet forwarded, plus USDG sent to it by
    ///         mistake (never owed to anyone). Forwarded forfeits reached the FeeRouter and nobody else.
    function invariant_ResolverBalanceEqualsBonds() public view {
        assertEq(
            usdg.balanceOf(address(resolver)),
            _sumClaimable() + _sumLive() + resolver.forfeited() + handler.donated(),
            "OR1: balance != claimable + live bonds + forfeits + stray"
        );
        assertEq(usdg.balanceOf(FEE_ROUTER), handler.forwarded(), "OR1: FeeRouter got != forwarded forfeits");
    }

    /// @notice OR2: no double credit. Everything ever credited (still claimable + already withdrawn) equals the sum
    ///         of the pots of the questions that reached FINAL or VOID, and each pot was credited once: total
    ///         credited never exceeds what was bonded in.
    function invariant_ResolverNoDoubleCredit() public view {
        assertFalse(handler.secondCredit(), "OR2: a question was credited twice");
        uint256 credited = _sumClaimable() + handler.totalWithdrawn();
        assertEq(credited, handler.totalCreditedSpec(), "OR2: credited != pots of resolved questions");
        assertTrue(
            credited + _sumLive() + resolver.forfeited() + handler.forwarded() == handler.bondsIn(),
            "OR2: credited + live + forfeits != bonds posted"
        );
        assertEq(resolver.forfeited() + handler.forwarded(), handler.forfeitedSpec(), "OR2: forfeits != spec");
    }

    /// @notice OR3: each pot goes to the right party: undisputed FINAL -> proposer; panel agrees -> proposer gets
    ///         its bond + half the disputer's; panel disagrees -> disputer gets its bond + half the proposer's;
    ///         panel silent -> each side gets half its own bond back.
    function invariant_ResolverCreditsRightParty() public view {
        for (uint256 i; i < 4; ++i) {
            address a = handler.actors(i);
            assertEq(
                resolver.claimableBond(a) + handler.withdrawnBy(a),
                handler.expectedCredit(a),
                "OR3: actor credited a different amount than the rules give"
            );
        }
    }

    /// @notice OR4: a question's state only moves forward (OPEN -> PROPOSED -> FINAL | DISPUTED -> FINAL | VOID)
    ///         and FINAL / VOID never change again.
    function invariant_ResolverStatesOnlyMoveForward() public view {
        assertFalse(handler.backwardsMove(), "OR4: a question moved backwards or left a terminal state");
        uint256 n = handler.qCount();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.qs(i);
            (IIfsoOutcomeResolver.State st,) = resolver.outcomeOf(id);
            assertEq(uint256(st), uint256(handler.seenState(id)), "OR4: state changed outside an observed call");
        }
    }

    /// @notice OR5 (audit M-1): no question is ever disputed by its own proposer, and every disputed question that
    ///         resolves forfeits at least bond / 2 to the FeeRouter, so two addresses of one owner cannot make a
    ///         dispute free (panel for, against, VOID or silent).
    function invariant_ResolverNoFreeSelfDispute() public view {
        assertFalse(handler.selfDisputed(), "OR5: a proposer disputed its own proposal");
        assertFalse(handler.cheapDispute(), "OR5: a disputed question forfeited less than bond / 2");
        uint256 n = handler.qCount();
        for (uint256 i; i < n; ++i) {
            IfsoOutcomeResolver.Question memory q = resolver.getQuestion(handler.qs(i));
            if (q.disputer != address(0)) assertTrue(q.disputer != q.proposer, "OR5: proposer == disputer");
        }
    }

    /// @notice The handler reaches the success branch of every path (the suite can never pass by doing nothing).
    function test_ResolverHandlerReachesEveryPath() public {
        for (uint256 i; i < 6; ++i) {
            handler.create(i, 1, 1 hours, 1 hours);
        }
        handler.propose(0, 0, 1, true);
        handler.finalize(0, true); //                         undisputed FINAL
        handler.propose(1, 1, 1, true);
        handler.setBond(500e6); //                             bond changes between proposal and dispute
        handler.dispute(1, 2);
        handler.panelResolve(1, 0, true); //                   panel agrees: proposer takes both
        handler.propose(2, 1, 2, true);
        handler.dispute(2, 3);
        handler.panelResolve(2, 0, false); //                  panel picks VOID: disputer takes both
        handler.propose(3, 2, 1, true);
        handler.dispute(3, 0);
        handler.timeout(3, true); //                           panel silent: VOID, bonds back
        handler.withdraw(0, false);
        handler.withdraw(1, true);
        handler.donate(7);
        handler.propose(4, 3, 1, true); //                     stays live
        handler.propose(5, 0, 1, true);
        handler.selfDispute(5); //                             refused (M-1)
        handler.dispute(5, 0); //                              same actor as proposer: refused
        handler.dispute(5, 1); //                              stays disputed
        handler.forward(); //                                  forfeits to the FeeRouter
        assertTrue(handler.nCreate() == 6 && handler.nFinalize() == 1 && handler.nPanelProposer() == 1, "paths a");
        assertTrue(handler.nPanelDisputer() == 1 && handler.nTimeout() == 1 && handler.nWithdraw() == 2, "paths b");
        assertEq(handler.nPropose(), 6, "paths propose");
        assertEq(handler.nDispute(), 4, "paths dispute");
        assertEq(handler.nSetBond(), 1, "paths setBond");
        assertTrue(handler.nSelfDisputeRefused() == 1 && handler.nForward() == 1, "paths self-dispute / forward");
        assertTrue(handler.forwarded() > 0, "forfeits reached the FeeRouter");
        invariant_ResolverBalanceEqualsBonds();
        invariant_ResolverNoDoubleCredit();
        invariant_ResolverCreditsRightParty();
        invariant_ResolverStatesOnlyMoveForward();
        invariant_ResolverNoFreeSelfDispute();
    }
}
