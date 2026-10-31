// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Origin: Own implementation, written for this repo (EIP-712 domain separator, recomputed when the chain id
//         changes). No code copied from OpenZeppelin, solmate or solady.

/// @notice Minimal EIP-712 domain with chain-id fork protection.
abstract contract EIP712 {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private immutable _nameHash;
    bytes32 private immutable _versionHash;
    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    constructor(string memory name, string memory version) {
        _nameHash = keccak256(bytes(name));
        _versionHash = keccak256(bytes(version));
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    /// @notice EIP-712 domain separator of this contract on this chain.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, _nameHash, _versionHash, block.chainid, address(this)));
    }

    function _hashTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }
}
