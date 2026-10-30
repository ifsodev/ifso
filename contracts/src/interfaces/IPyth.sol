// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal Pyth Core (pull oracle) interface. RHC Core: 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a.
library PythStructs {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    struct PriceFeed {
        bytes32 id;
        Price price;
        Price emaPrice;
    }
}

interface IPyth {
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);

    /// @notice Verifies `updateData` and returns, for each id, a price whose publishTime is in [min, max].
    function parsePriceFeedUpdates(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory priceFeeds);

    /// @notice Like parsePriceFeedUpdates but only accepts the FIRST update at/after minPublishTime
    ///         (its previous publish time is < minPublishTime). Used for "price at the deadline".
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory priceFeeds);
}
