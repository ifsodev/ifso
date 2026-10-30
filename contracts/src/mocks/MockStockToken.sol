// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice ERC-8056 multiplier double (Stock Token corporate actions).
contract MockStockToken {
    uint256 public uiMultiplier = 1e18;
    uint256 public newUIMultiplier;
    uint256 public effectiveAt;

    function setMultiplier(uint256 m) external {
        uiMultiplier = m;
    }

    function schedule(uint256 m, uint256 at) external {
        newUIMultiplier = m;
        effectiveAt = at;
    }
}
