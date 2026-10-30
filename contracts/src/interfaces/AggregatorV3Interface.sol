// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Chainlink Data Feeds proxy interface. On RHC, tokenized-equity feeds are 8 decimals, 24/5,
///         heartbeat 86400 s, 0.5% deviation, and already include the Stock Token multiplier.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);

    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
