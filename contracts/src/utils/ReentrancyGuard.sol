// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Origin: Own implementation, written for this repo (single storage-slot lock). No code copied from OpenZeppelin,
//         solmate or solady.

/// @notice Storage-slot reentrancy guard (kept non-transient for maximum tooling compatibility).
abstract contract ReentrancyGuard {
    error Reentrancy();

    uint256 private _locked = 1;

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }
}
