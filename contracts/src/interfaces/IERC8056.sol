// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice ERC-8056 scaled-UI-amount extension used by Robinhood Stock Tokens (non-rebasing, 18 decimals).
interface IERC8056 {
    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
}
