// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IfsoFixture} from "./utils/IfsoFixture.sol";
import {IfsoEscrow} from "../src/IfsoEscrow.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {Condition, CreateParams, Kind} from "../src/libraries/IfsoTypes.sol";

/// @notice QUOTE-1: the amount the app shows and signs (amount + the fee the escrow reports) equals what the
///         contract pulls, on the real fixture (real escrow, evaluator, resolver, router; the USDG double moves
///         cash), for every create path and after setFees changes. The app-side half of the parity check, the
///         typed data the builder produces, lives in app/test/typedData.test.ts.
contract ViewEqualsExecutionTest is IfsoFixture {
    function _outcomeCond() internal returns (Condition memory) {
        uint64 close = uint64(T0 + 3 days);
        vm.prank(creator);
        bytes32 qid =
            resolver.createQuestion(keccak256(abi.encode("q", saltCounter)), close, close + 2 hours, 2, "ipfs://q");
        return _outcome(qid, 2);
    }

    function _expiryFor(Kind kind) internal pure returns (uint64) {
        return kind == Kind.OUTCOME ? uint64(T0 + 20 days) : uint64(T0 + 8 days);
    }

    function _paramsFor(Kind kind) internal returns (CreateParams memory p, uint96 fee) {
        Condition memory c = kind == Kind.OUTCOME ? _outcomeCond() : _time(uint64(T0 + 1 days));
        p = _params(c, recipient, address(0), 20e6, _expiryFor(kind));
        fee = escrow.feeFor(kind); // what the builder shows before the user signs
    }

    function _setFees(uint96 creation, uint96 resolverFee) internal {
        vm.prank(owner);
        escrow.setFees(creation, resolverFee);
    }

    /// @dev create(): pulls exactly amount + the reported fee; escrow keeps the amount; router gets the fee.
    function _checkCreate(Kind kind) internal {
        (CreateParams memory p, uint96 fee) = _paramsFor(kind);
        uint256 senderBefore = usdg.balanceOf(sender);
        uint256 routerBefore = usdg.balanceOf(address(router));
        uint256 escrowBefore = usdg.balanceOf(address(escrow));
        vm.prank(sender);
        escrow.create(p);
        assertEq(senderBefore - usdg.balanceOf(sender), uint256(p.amount) + fee, "sender pays amount + reported fee");
        assertEq(usdg.balanceOf(address(router)) - routerBefore, fee, "router gets the reported fee");
        assertEq(usdg.balanceOf(address(escrow)) - escrowBefore, p.amount, "escrow holds exactly the amount");
    }

    function test_Create_PullsAmountPlusReportedFee_TimeAndOutcome() public {
        _checkCreate(Kind.TIME);
        _checkCreate(Kind.OUTCOME);
    }

    function test_Create_AfterSetFees_PullsTheNewReportedFee() public {
        _setFees(1_750_000, 3_250_000);
        _checkCreate(Kind.TIME);
        _checkCreate(Kind.OUTCOME);
        _setFees(0, 0);
        _checkCreate(Kind.TIME);
        _setFees(5e6, 5e6);
        _checkCreate(Kind.OUTCOME);
    }

    /// @dev Gasless create: the typed data the user signs says value = amount + fee. It pulls exactly that, and a
    ///      signature made for the OLD fee fails after setFees (it can never pull more than the user signed).
    function test_CreateWithAuthorization_SignedValueEqualsPulled_AndStaleFeeFails() public {
        (CreateParams memory p, uint96 fee) = _paramsFor(Kind.TIME);
        bytes32 nonce = escrow.createAuthNonce(sender, p);
        uint256 signed = uint256(p.amount) + fee;
        bytes memory auth = _usdgAuthSig(senderPk, sender, address(escrow), signed, T0 - 1, T0 + 1 hours, nonce);

        _setFees(2e6, 0); // the owner changes the fee between preview and relay
        vm.prank(keeper);
        vm.expectRevert(MockUSDG.InvalidSignature.selector);
        escrow.createWithAuthorization(p, sender, T0 - 1, T0 + 1 hours, auth);

        // the app re-quotes with the new fee and the same params: the pulled amount equals the new signed value
        uint96 fee2 = escrow.feeFor(Kind.TIME);
        assertEq(uint256(fee2), 2e6, "new reported fee");
        bytes memory auth2 =
            _usdgAuthSig(senderPk, sender, address(escrow), uint256(p.amount) + fee2, T0 - 1, T0 + 1 hours, nonce);
        uint256 before = usdg.balanceOf(sender);
        vm.prank(keeper);
        escrow.createWithAuthorization(p, sender, T0 - 1, T0 + 1 hours, auth2);
        assertEq(before - usdg.balanceOf(sender), uint256(p.amount) + fee2, "pulled == signed");
        assertEq(usdg.balanceOf(address(router)), fee2, "router fee == reported fee");
    }

    /// @dev Permit path: the permit value the app signs (amount + fee) is what create pulls.
    function test_CreateWithPermit_AfterSetFees_PullsSignedValue() public {
        _setFees(1_100_000, 0);
        vm.prank(sender);
        usdg.approve(address(escrow), 0); // allowance comes only from the permit
        (CreateParams memory p, uint96 fee) = _paramsFor(Kind.TIME);
        uint256 total = uint256(p.amount) + fee;
        uint256 deadline = T0 + 1 hours;
        bytes32 sh = keccak256(
            abi.encode(usdg.PERMIT_TYPEHASH(), sender, address(escrow), total, usdg.nonces(sender), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(senderPk, digest);
        uint256 before = usdg.balanceOf(sender);
        vm.prank(sender);
        escrow.createWithPermit(p, deadline, v, r, s);
        assertEq(before - usdg.balanceOf(sender), total, "pulled == permitted");
        assertEq(usdg.allowance(sender, address(escrow)), 0, "the permit value was fully used");
    }

    /// @dev Batch: the app sums amount + fee per row; the contract pulls exactly that sum.
    function test_CreateBatch_PullsSumOfAmountsAndReportedFees() public {
        _setFees(600_000, 900_000);
        CreateParams[] memory ps = new CreateParams[](2);
        uint256 expected;
        (CreateParams memory a, uint96 fa) = _paramsFor(Kind.TIME);
        (CreateParams memory b, uint96 fb) = _paramsFor(Kind.OUTCOME);
        ps[0] = a;
        ps[1] = b;
        expected = uint256(a.amount) + fa + uint256(b.amount) + fb;
        uint256 before = usdg.balanceOf(sender);
        vm.prank(sender);
        escrow.createBatch(ps);
        assertEq(before - usdg.balanceOf(sender), expected, "batch pull == sum of amount + reported fee");
        assertEq(usdg.balanceOf(address(router)), uint256(fa) + fb, "router fee == sum of reported fees");
    }

    /// @dev A fee change never touches an existing escrow: what it holds is what was paid in.
    function test_SetFees_DoesNotChangeExistingEscrowBalance() public {
        (CreateParams memory p,) = _paramsFor(Kind.TIME);
        vm.prank(sender);
        uint256 id = escrow.create(p);
        _setFees(5e6, 5e6);
        assertEq(usdg.balanceOf(address(escrow)), p.amount, "escrow balance unchanged by setFees");
        vm.warp(T0 + 9 days);
        uint256 before = usdg.balanceOf(sender);
        escrow.refund(id, false, false);
        assertEq(usdg.balanceOf(sender) - before, p.amount, "refund returns the amount, never a fee");
    }
}
