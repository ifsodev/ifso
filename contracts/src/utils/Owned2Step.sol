// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Two-step ownership (owner = brand multisig). Owner powers in IFSO never reach escrowed funds.
abstract contract Owned2Step {
    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    address public pendingOwner;

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Starts a two-step ownership transfer; the new owner must accept.
    /// @param newOwner Address that must call acceptOwnership to take over.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Pending owner completes the ownership transfer.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
