// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "./ECDSA.sol";
import {IERC1271} from "../interfaces/IERC1271.sol";

/// @notice EOA (ECDSA) or smart-account (EIP-1271, e.g. ZeroDev Kernel with a passkey validator) signatures.
///         Counterfactual (undeployed) accounts are NOT supported here (no ERC-6492); they act via UserOps,
///         where msg.sender-based entry points apply.
library SignatureChecker {
    bytes4 internal constant MAGIC = 0x1626ba7e;

    function isValid(address signer, bytes32 digest, bytes memory sig) internal view returns (bool) {
        if (signer == address(0)) return false;
        if (signer.code.length == 0) {
            if (sig.length != 65) return false;
            (uint8 v, bytes32 r, bytes32 s) = ECDSA.split(sig);
            if (uint256(s) > ECDSA.HALF_N || (v != 27 && v != 28)) return false;
            return ecrecover(digest, v, r, s) == signer;
        }
        (bool ok, bytes memory ret) = signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, sig)));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes32)) == bytes32(MAGIC);
    }
}
