// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "../libraries/ECDSA.sol";

/// @notice Smart-account double: validates EIP-1271 signatures from a single owner key, and can make calls.
contract MockERC1271Wallet {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        return ECDSA.recover(hash, sig) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function exec(address to, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == signer, "only signer");
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}
