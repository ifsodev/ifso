// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./IERC20.sol";

/// @notice USDG on Robinhood Chain (0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168), 6 decimals.
///         Verified on-chain 2026-10-25: EIP-2612 permit AND EIP-3009 (transfer/receiveWithAuthorization),
///         EIP-712 domain {name:"Global Dollar", version:"1", chainId:4663, verifyingContract:USDG}.
///         The v,r,s overloads below are the Circle FiatToken-style signatures (U: confirm the bytes-signature
///         overload is not the only one exposed by the implementation; functional tests on a fork settle it).
interface IUSDG is IERC20 {
    // EIP-2612
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
    function nonces(address owner) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    // EIP-3009
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
