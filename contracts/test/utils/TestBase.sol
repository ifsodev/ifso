// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Origin: Own test base. The Vm interface below re-declares the cheatcodes used here from Foundry's public cheatcode
//         list (same signatures as forge-std's Vm); no forge-std source is vendored.

/// @notice Subset of the Foundry cheatcode interface (same address/signatures as forge-std's Vm), vendored
///         so the repo compiles and tests run without `forge install`. Works under Foundry and Hardhat 3.
interface Vm {
    struct DirEntry {
        string errorMessage;
        string path;
        uint64 depth;
        bool isDir;
        bool isSymlink;
    }

    function warp(uint256 newTimestamp) external;
    function prank(address sender) external;
    function prank(address sender, address origin) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function deal(address who, uint256 newBalance) external;
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 privateKey) external pure returns (address);
    function label(address account, string calldata newLabel) external;
    function assume(bool condition) external pure;
    function envUint(string calldata name) external view returns (uint256);
    function envAddress(string calldata name) external view returns (address);
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function startBroadcast() external;
    function snapshotState() external returns (uint256 snapshotId);
    function revertToState(uint256 snapshotId) external returns (bool success);
    function chainId(uint256 newChainId) external;
    function exists(string calldata path) external view returns (bool);
    function envOr(string calldata name, bool defaultValue) external view returns (bool);
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
    function writeFile(string calldata path, string calldata data) external;
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function toString(address value) external pure returns (string memory);
    function toString(uint256 value) external pure returns (string memory);
    function toString(bytes32 value) external pure returns (string memory);
    function setEnv(string calldata name, string calldata value) external;
    function getCode(string calldata artifactPath) external view returns (bytes memory);
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function readCallers() external returns (uint8 callerMode, address msgSender, address txOrigin);
    function readDir(string calldata path) external view returns (DirEntry[] memory entries);
    function parseJsonAddressArray(string calldata json, string calldata key) external pure returns (address[] memory);
    function parseJsonString(string calldata json, string calldata key) external pure returns (string memory);
    // fork + storage cheatcodes (fork proofs, test/fork)
    function createSelectFork(string calldata urlOrAlias) external returns (uint256 forkId);
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber) external returns (uint256 forkId);
    function load(address target, bytes32 slot) external view returns (bytes32 data);
    function store(address target, bytes32 slot, bytes32 value) external;
    function mockCall(address callee, bytes calldata data, bytes calldata returnData) external;
    function clearMockedCalls() external;
    function skip(bool skipTest) external;
    function rpc(string calldata method, string calldata params) external returns (bytes memory data);
    function getBlockNumber() external view returns (uint256 height);
    function getBlockTimestamp() external view returns (uint256 timestamp);
    function expectRevert(bytes4 revertData, address reverter) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bool public IS_TEST = true;

    error AssertionFailed(string what);

    function fail(string memory what) internal pure {
        revert AssertionFailed(what);
    }

    function assertTrue(bool c, string memory what) internal pure {
        if (!c) fail(what);
    }

    function assertTrue(bool c) internal pure {
        if (!c) fail("assertTrue");
    }

    function assertFalse(bool c, string memory what) internal pure {
        if (c) fail(what);
    }

    function assertEq(uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) fail(string.concat(what, ": ", _u(a), " != ", _u(b)));
    }

    function assertEq(uint256 a, uint256 b) internal pure {
        assertEq(a, b, "assertEq(uint)");
    }

    function assertEq(int256 a, int256 b, string memory what) internal pure {
        if (a != b) fail(what);
    }

    function assertEq(address a, address b, string memory what) internal pure {
        if (a != b) fail(what);
    }

    function assertEq(address a, address b) internal pure {
        if (a != b) fail("assertEq(address)");
    }

    function assertEq(bytes32 a, bytes32 b, string memory what) internal pure {
        if (a != b) fail(what);
    }

    function assertEq(bool a, bool b, string memory what) internal pure {
        if (a != b) fail(what);
    }

    function assertGt(uint256 a, uint256 b, string memory what) internal pure {
        if (a <= b) fail(what);
    }

    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (lo > hi) fail("bound");
        if (x >= lo && x <= hi) return x;
        uint256 size = hi - lo + 1;
        return lo + (x % size);
    }

    function _u(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory b = new bytes(len);
        while (v != 0) {
            b[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }
}
