// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "../utils/TestBase.sol";
import {IfsoEscrow} from "../../src/IfsoEscrow.sol";
import {IfsoConditionEvaluator} from "../../src/IfsoConditionEvaluator.sol";
import {IIfsoEscrow} from "../../src/interfaces/IIfsoEscrow.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {
    Condition,
    CreateParams,
    Kind,
    Status,
    APPROVE_PARTIES,
    APPROVE_REFEREE
} from "../../src/libraries/IfsoTypes.sol";

/// @notice Drives IfsoEscrow through every user and owner path with bounded random inputs, keeping ghost state for
///         the invariants in EscrowInvariants.t.sol. Every call is wrapped so a revert is a no-op, never a test failure;
///         the invariants decide what is a bug.
contract EscrowHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    IfsoEscrow public immutable escrow;
    IfsoConditionEvaluator public immutable evaluator;
    MockUSDG public immutable usdg;
    address public immutable owner;

    address[3] public senders = [address(0x5E1), address(0x5E2), address(0x5E3)];
    address[3] public recipients = [address(0x7E1), address(0x7E2), address(0x7E3)];
    address public constant REFEREE = address(0x7EF);
    address public constant DONOR = address(0xD0);
    uint256 internal constant LINK_PK = 0x11AA22BB; // test-key (throwaway, local only)
    address public immutable linkKey;

    uint256[] public ids;
    mapping(uint256 => Status) public lastStatus;

    // ghosts
    uint256 public donated; //            USDG sent straight to the escrow (not owed to anyone)
    bool public statusRegressed; //        R5
    string public regressionNote;
    bool public ownerMovedFunds; //        R7
    uint256 public ownerCalls;
    mapping(bytes32 => uint256) public calls; // successful calls per path (path name as bytes32)

    constructor(IfsoEscrow escrow_, IfsoConditionEvaluator evaluator_, MockUSDG usdg_, address owner_) {
        escrow = escrow_;
        evaluator = evaluator_;
        usdg = usdg_;
        owner = owner_;
        linkKey = vm.addr(LINK_PK);
        for (uint256 i; i < 3; ++i) {
            _fund(senders[i]);
            _fund(recipients[i]);
        }
        usdg.mint(DONOR, 1e15);
    }

    function _fund(address a) internal {
        usdg.mint(a, 1e15);
        vm.prank(a);
        usdg.approve(address(escrow), type(uint256).max);
    }

    // ------------------------------------------------------------------ views for the invariants
    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function allIds() external view returns (uint256[] memory) {
        return ids;
    }

    // ------------------------------------------------------------------ creates
    function createTime(uint256 actor, uint96 amount, uint32 deadlineIn, uint32 extra, bool link, bool cancellable)
        external
    {
        uint64 nowTs = uint64(block.timestamp);
        Condition memory c;
        c.kind = Kind.TIME;
        c.deadline = nowTs + uint64(_bound(deadlineIn, 1 hours, 5 days));
        CreateParams memory p = _base(actor, amount, link, c.deadline + 1 days + uint64(_bound(extra, 0, 5 days)));
        p.cancellable = cancellable;
        p.condition = c;
        _doCreate(actor, p);
    }

    function createApprove(uint256 actor, uint96 amount, uint32 expiryIn, bool link, bool useReferee) external {
        Condition memory c;
        c.kind = Kind.APPROVE;
        if (useReferee) {
            c.mode = APPROVE_REFEREE;
            c.target = REFEREE;
        } else {
            c.mode = APPROVE_PARTIES;
        }
        CreateParams memory p =
            _base(actor, amount, link, uint64(block.timestamp) + uint64(_bound(expiryIn, 1 hours, 10 days)));
        p.condition = c;
        _doCreate(actor, p);
    }

    function createChallenge(uint256 actor, uint96 amount, uint96 counter, uint32 acceptIn, uint32 extra, bool link)
        external
    {
        Condition memory c;
        c.kind = Kind.APPROVE;
        c.mode = APPROVE_REFEREE;
        c.target = REFEREE;
        uint64 acceptBy = uint64(block.timestamp) + uint64(_bound(acceptIn, 1, 3 days));
        CreateParams memory p = _base(actor, amount, link, acceptBy + uint64(_bound(extra, 1, 7 days)));
        p.twoSided = true;
        p.counterAmount = uint96(_bound(counter, 1e6, 1_200e6));
        p.acceptBy = acceptBy;
        p.condition = c;
        _doCreate(actor, p);
    }

    function _base(uint256 actor, uint96 amount, bool link, uint64 expiry)
        internal
        view
        returns (CreateParams memory p)
    {
        p.amount = uint96(_bound(amount, 1e6, 1_200e6)); // crosses the 1,000 USDG cap on purpose
        if (link) p.linkKey = linkKey;
        else p.recipient = recipients[actor % 3];
        p.expiry = expiry;
        if (actor % 2 == 0) p.altRefundTo = address(uint160(0xA170 + (actor % 3)));
        p.salt = keccak256(abi.encode(ids.length, block.timestamp, actor));
    }

    function _doCreate(uint256 actor, CreateParams memory p) internal {
        vm.prank(senders[actor % 3]);
        try escrow.create(p) returns (uint256 id) {
            ids.push(id);
            calls["create"]++;
        } catch {}
        _sync();
    }

    // ------------------------------------------------------------------ entries and exits
    function accept(uint256 idSeed, uint256 who) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        IIfsoEscrow.Escrow memory e = escrow.getEscrow(id);
        address acceptor = e.linkKey == address(0) ? e.recipient : recipients[who % 3];
        bytes memory sig;
        if (e.linkKey != address(0)) sig = _sign(escrow.hashAccept(id, acceptor, e.conditionHash));
        vm.prank(acceptor);
        try escrow.accept(id, sig, address(0)) {
            calls["accept"]++;
        } catch {}
        _sync();
    }

    function claim(uint256 idSeed, uint256 who) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        address to = recipients[who % 3];
        bytes memory sig = _sign(escrow.hashClaim(id, to, escrow.getEscrow(id).conditionHash));
        try escrow.claim(id, to, sig) {
            calls["claim"]++;
        } catch {}
        _sync();
    }

    function settle(uint256 idSeed) external {
        if (ids.length == 0) return;
        try escrow.settle(ids[idSeed % ids.length], "", false) {
            calls["settle"]++;
        } catch {}
        _sync();
    }

    function approve(uint256 idSeed, bool bySender) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        IIfsoEscrow.Escrow memory e = escrow.getEscrow(id);
        vm.prank(bySender ? e.sender : e.recipient);
        try escrow.approve(id) {
            calls["approve"]++;
        } catch {}
        _sync();
    }

    function decline(uint256 idSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        vm.prank(escrow.getEscrow(id).recipient);
        try escrow.decline(id) {
            calls["decline"]++;
        } catch {}
        _sync();
    }

    function refereeDecide(uint256 idSeed, bool toRecipient) external {
        if (ids.length == 0) return;
        vm.prank(REFEREE);
        try escrow.refereeDecide(ids[idSeed % ids.length], toRecipient) {
            calls["referee"]++;
        } catch {}
        _sync();
    }

    function cancel(uint256 idSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        vm.prank(escrow.getEscrow(id).sender);
        try escrow.cancel(id) {
            calls["cancel"]++;
        } catch {}
        _sync();
    }

    function refund(uint256 idSeed, bool senderAlt, bool counterAlt, address caller) external {
        if (ids.length == 0) return;
        vm.prank(caller);
        try escrow.refund(ids[idSeed % ids.length], senderAlt, counterAlt) {
            calls["refund"]++;
        } catch {}
        _sync();
    }

    function setRefund(uint256 idSeed, uint160 to) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        address dest = address(uint160(_bound(to, 0x1000, 0xFFFF)));
        vm.prank(escrow.getEscrow(id).sender);
        try escrow.setRefundAddresses(id, dest, address(0)) {
            calls["setRefund"]++;
        } catch {}
        _sync();
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + _bound(secs, 1, 2 days));
        _sync();
    }

    /// @dev GEN-3: a stray transfer must never break accounting or exits.
    function donate(uint96 amount) external {
        uint256 a = _bound(amount, 1, 50e6);
        vm.prank(DONOR);
        usdg.transfer(address(escrow), a);
        donated += a;
        _sync();
    }

    // ------------------------------------------------------------------ owner powers (R7)
    function ownerAction(uint8 which, uint96 value, bool flag) external {
        uint256 bal = usdg.balanceOf(address(escrow));
        bytes32[] memory before = _escrowHashes();
        vm.startPrank(owner);
        uint8 w = which % 7;
        if (w == 0) {
            try escrow.setFees(uint96(_bound(value, 0, 5e6)), uint96(_bound(value / 7, 0, 5e6))) {} catch {}
        } else if (w == 1) {
            escrow.setCreationPaused(flag);
        } else if (w == 2) {
            try escrow.setMaxAmount(flag ? 0 : uint96(_bound(value, 1e6, 2_000e6))) {} catch {}
        } else if (w == 3) {
            escrow.transferOwnership(flag ? owner : address(0xBEEF)); // never accepted: owner keeps control
        } else if (w == 4) {
            evaluator.setFeed(address(uint160(value)), flag, address(0));
        } else if (w == 5) {
            evaluator.setResolver(address(uint160(value)), flag);
        } else {
            escrow.setCreationPaused(false);
        }
        vm.stopPrank();
        ownerCalls++;
        if (usdg.balanceOf(address(escrow)) != bal) ownerMovedFunds = true;
        bytes32[] memory afterHashes = _escrowHashes();
        for (uint256 i; i < afterHashes.length; ++i) {
            if (afterHashes[i] != before[i]) ownerMovedFunds = true;
        }
        _sync();
    }

    function _escrowHashes() internal view returns (bytes32[] memory h) {
        h = new bytes32[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            h[i] = keccak256(abi.encode(escrow.getEscrow(ids[i])));
        }
    }

    // ------------------------------------------------------------------ R5 bookkeeping
    /// @dev Allowed moves: NONE->OPEN, OPEN->{MET,RELEASED,RETURNED,VOIDED,CANCELLED}, MET->{RELEASED,RETURNED}.
    function _sync() internal {
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            Status prev = lastStatus[id];
            Status cur = escrow.getEscrow(id).status;
            if (cur == prev) continue;
            bool ok = (prev == Status.NONE && cur == Status.OPEN) || (prev == Status.OPEN && cur != Status.NONE)
                || (prev == Status.MET && (cur == Status.RELEASED || cur == Status.RETURNED));
            if (!ok) {
                statusRegressed = true;
                regressionNote = string.concat(vm.toString(uint256(prev)), "->", vm.toString(uint256(cur)));
            }
            lastStatus[id] = cur;
        }
    }

    // ------------------------------------------------------------------ utils
    function _sign(bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(LINK_PK, digest);
        return abi.encodePacked(r, s, v);
    }

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }
}
