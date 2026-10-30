// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Chainlink proxy double with full round history and phase support
///         (roundId = phaseId << 64 | aggregatorRoundId), 8 decimals.
contract MockAggregator {
    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
    }

    uint8 public constant decimals = 8;
    string public description;
    uint256 public constant version = 6;
    uint16 public phaseId = 1;
    uint64 public aggRound; // latest aggregator round in the current phase
    mapping(uint80 => Round) internal _rounds;
    uint80 public latestId;

    error NoData();

    constructor(string memory desc) {
        description = desc;
    }

    /// @notice Push a round with an explicit timestamp (tests use history in the past).
    function push(int256 answer, uint256 updatedAt) public returns (uint80 id) {
        aggRound += 1;
        id = (uint80(phaseId) << 64) | aggRound;
        _rounds[id] = Round(answer, updatedAt, updatedAt);
        latestId = id;
    }

    function pushNow(int256 answer) external returns (uint80) {
        return push(answer, block.timestamp);
    }

    /// @notice Simulates an aggregator upgrade behind the proxy.
    function newPhase() external {
        phaseId += 1;
        aggRound = 0;
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = _rounds[roundId];
        if (r.updatedAt == 0) revert NoData();
        return (roundId, r.answer, r.startedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = _rounds[latestId];
        return (latestId, r.answer, r.startedAt, r.updatedAt, latestId);
    }
}
