// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Origin: Own implementation, written for this repo (low-level call that accepts tokens returning nothing or true).
//         No code copied from OpenZeppelin, solmate or solady.

/// @notice Minimal safe ERC-20 transfer helpers (handles tokens that return nothing or false).
library SafeTransferLib {
    error TransferFailed();
    error TransferFromFailed();
    error EthTransferFailed();

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool))) || token.code.length == 0) {
            revert TransferFailed();
        }
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool))) || token.code.length == 0) {
            revert TransferFromFailed();
        }
    }

    function safeTransferETH(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
