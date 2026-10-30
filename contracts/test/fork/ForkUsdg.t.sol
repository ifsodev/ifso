// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {Condition, CreateParams, Kind, Status} from "../../src/libraries/IfsoTypes.sol";

/// @notice R1-R3: the real USDG gasless paths (EIP-3009 receiveWithAuthorization v,r,s and EIP-2612 permit).
contract ForkUsdgTest is ForkBase {
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function _timeParams(uint96 amount) internal returns (CreateParams memory p) {
        Condition memory c;
        c.kind = Kind.TIME;
        c.deadline = uint64(block.timestamp + 1 days);
        p = _named(c, amount, uint64(block.timestamp + 3 days));
    }

    function _copy(CreateParams memory p) internal pure returns (CreateParams memory) {
        return abi.decode(abi.encode(p), (CreateParams)); // memory structs alias on assignment
    }

    function _authSig(address from, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(RECEIVE_TYPEHASH, from, address(escrow), value, va, vb, nonce));
        return _sig(senderPk, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), sh)));
    }

    function testFork_DomainSeparator_IsGlobalDollarOn4663() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Global Dollar"),
                keccak256("1"),
                uint256(4663),
                USDG
            )
        );
        assertEq(usdg.DOMAIN_SEPARATOR(), expected, "USDG domain separator");
    }

    function testFork_CreateWithAuthorization_RealUSDG() public {
        CreateParams memory p = _timeParams(100e6);
        uint256 fee = escrow.feeFor(Kind.TIME);
        uint256 total = uint256(p.amount) + fee;
        _dealUsdg(sender, total);
        bytes32 nonce = escrow.createAuthNonce(sender, p);
        uint256 vb = block.timestamp + 1 hours;
        bytes memory sig = _authSig(sender, total, 0, vb, nonce);

        uint256 routerBefore = usdg.balanceOf(address(router));
        vm.prank(relayer); // anyone relays: the sender pays no gas
        uint256 id = escrow.createWithAuthorization(p, sender, 0, vb, sig);

        assertEq(usdg.balanceOf(sender), 0, "sender debited");
        assertEq(usdg.balanceOf(address(escrow)), p.amount, "escrow funded");
        assertEq(usdg.balanceOf(address(router)) - routerBefore, fee, "fee routed");
        assertTrue(usdg.authorizationState(sender, nonce), "authorization used");
        assertTrue(_status(id) == Status.OPEN, "escrow open");
        assertEq(escrow.getEscrow(id).sender, sender, "sender is the signer, not the relayer");
    }

    function testFork_CreateWithPermit_RealUSDG() public {
        CreateParams memory p = _timeParams(50e6);
        uint256 fee = escrow.feeFor(Kind.TIME);
        uint256 total = uint256(p.amount) + fee;
        _dealUsdg(sender, total);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 sh =
            keccak256(abi.encode(PERMIT_TYPEHASH, sender, address(escrow), total, usdg.nonces(sender), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(senderPk, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), sh)));

        uint256 nonceBefore = usdg.nonces(sender);
        uint256 routerBefore = usdg.balanceOf(address(router));
        vm.prank(sender);
        uint256 id = escrow.createWithPermit(p, deadline, v, r, s);

        assertEq(usdg.nonces(sender), nonceBefore + 1, "permit consumed");
        assertEq(usdg.allowance(sender, address(escrow)), 0, "allowance fully used");
        assertEq(usdg.balanceOf(address(escrow)), p.amount, "escrow funded");
        assertEq(usdg.balanceOf(address(router)) - routerBefore, fee, "fee routed");
        assertTrue(_status(id) == Status.OPEN, "escrow open");
    }

    function testFork_3009_TamperReverts() public {
        CreateParams memory p = _timeParams(100e6);
        uint256 total = uint256(p.amount) + escrow.feeFor(Kind.TIME);
        _dealUsdg(sender, total + 10e6);
        uint256 vb = block.timestamp + 1 hours;
        bytes memory sig = _authSig(sender, total, 0, vb, escrow.createAuthNonce(sender, p));

        // 1. changed amount (value and nonce no longer match the signature)
        CreateParams memory q = _copy(p);
        q.amount = p.amount + 1e6;
        vm.prank(relayer);
        vm.expectRevert();
        escrow.createWithAuthorization(q, sender, 0, vb, sig);

        // 2. re-pointed recipient (nonce binds every param)
        q = _copy(p);
        q.recipient = relayer;
        vm.prank(relayer);
        vm.expectRevert();
        escrow.createWithAuthorization(q, sender, 0, vb, sig);

        // 3. changed validBefore
        vm.prank(relayer);
        vm.expectRevert();
        escrow.createWithAuthorization(p, sender, 0, vb + 1, sig);

        // 4. wrong `from` (someone else's address with the sender's signature)
        vm.prank(relayer);
        vm.expectRevert();
        escrow.createWithAuthorization(p, relayer, 0, vb, sig);

        // 5. expired authorization
        vm.warp(vb + 1);
        vm.prank(relayer);
        vm.expectRevert();
        escrow.createWithAuthorization(p, sender, 0, vb, sig);
        vm.warp(forkNow);

        // the untampered call still works once, then a replay reverts
        vm.prank(relayer);
        escrow.createWithAuthorization(p, sender, 0, vb, sig);
        assertEq(usdg.balanceOf(address(escrow)), p.amount, "only the honest call moved money");
        vm.prank(relayer);
        vm.expectRevert();
        escrow.createWithAuthorization(p, sender, 0, vb, sig);
    }
}
