// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
// Origin: Re-declared here from EIP-1271 (one function). No upstream file is vendored.

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4 magicValue);
}
