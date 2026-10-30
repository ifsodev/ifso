// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PythStructs} from "../interfaces/IPyth.sol";

/// @notice Pyth Core double. updateData[i] = abi.encode(bytes32 id, int64 price, uint64 conf, int32 expo,
///         uint64 publishTime, uint64 prevPublishTime). Charges `fee` wei per update.
contract MockPyth {
    uint256 public fee = 1;

    error InsufficientFee();
    error PriceFeedNotFoundWithinRange();

    function setFee(uint256 f) external {
        fee = f;
    }

    function encode(bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime, uint64 prevPublishTime)
        external
        pure
        returns (bytes memory)
    {
        return abi.encode(id, price, conf, expo, publishTime, prevPublishTime);
    }

    function getUpdateFee(bytes[] calldata updateData) public view returns (uint256) {
        return fee * updateData.length;
    }

    function parsePriceFeedUpdates(bytes[] calldata updateData, bytes32[] calldata ids, uint64 minT, uint64 maxT)
        external
        payable
        returns (PythStructs.PriceFeed[] memory)
    {
        return _parse(updateData, ids, minT, maxT, false);
    }

    function parsePriceFeedUpdatesUnique(bytes[] calldata updateData, bytes32[] calldata ids, uint64 minT, uint64 maxT)
        external
        payable
        returns (PythStructs.PriceFeed[] memory)
    {
        return _parse(updateData, ids, minT, maxT, true);
    }

    struct Upd {
        bytes32 id;
        int64 price;
        uint64 conf;
        int32 expo;
        uint64 t;
        uint64 prevT;
    }

    function _decode(bytes calldata d) internal pure returns (Upd memory u) {
        (u.id, u.price, u.conf, u.expo, u.t, u.prevT) = abi.decode(d, (bytes32, int64, uint64, int32, uint64, uint64));
    }

    function _parse(bytes[] calldata updateData, bytes32[] calldata ids, uint64 minT, uint64 maxT, bool unique)
        internal
        returns (PythStructs.PriceFeed[] memory feeds)
    {
        if (msg.value < getUpdateFee(updateData)) revert InsufficientFee();
        feeds = new PythStructs.PriceFeed[](ids.length);
        for (uint256 j; j < ids.length; ++j) {
            bool found;
            for (uint256 i; i < updateData.length; ++i) {
                Upd memory u = _decode(updateData[i]);
                if (u.id != ids[j] || u.t < minT || u.t > maxT) continue;
                if (unique && u.prevT >= minT) continue;
                PythStructs.Price memory p = PythStructs.Price(u.price, u.conf, u.expo, u.t);
                feeds[j] = PythStructs.PriceFeed(u.id, p, p);
                found = true;
                break;
            }
            if (!found) revert PriceFeedNotFoundWithinRange();
        }
    }
}
