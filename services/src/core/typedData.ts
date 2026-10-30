// EIP-712 definitions shared by the web app, bot relayer and tests. Type strings MUST match the
// Solidity typehashes in IfsoEscrow.sol (checked by test/typedData.test.ts against the .sol source).
import type { Address, Hex } from "viem";
import { ACTION_DECLINE, ACTION_OK, ACTION_REFEREE_RELEASE, ACTION_REFEREE_RETURN } from "./types";

export const IFSO_DOMAIN_NAME = "IFSO";
export const IFSO_DOMAIN_VERSION = "1";

export function ifsoDomain(chainId: number, escrow: Address) {
  return { name: IFSO_DOMAIN_NAME, version: IFSO_DOMAIN_VERSION, chainId, verifyingContract: escrow } as const;
}

export const claimTypes = {
  Claim: [
    { name: "id", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "conditionHash", type: "bytes32" },
  ],
} as const;

export const acceptTypes = {
  Accept: [
    { name: "id", type: "uint256" },
    { name: "acceptor", type: "address" },
    { name: "conditionHash", type: "bytes32" },
  ],
} as const;

export const decisionTypes = {
  Decision: [
    { name: "id", type: "uint256" },
    { name: "action", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const refundRedirectTypes = {
  RefundRedirect: [
    { name: "id", type: "uint256" },
    { name: "refundTo", type: "address" },
    { name: "altRefundTo", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const DecisionAction = {
  OK: ACTION_OK,
  DECLINE: ACTION_DECLINE,
  REFEREE_RELEASE: ACTION_REFEREE_RELEASE,
  REFEREE_RETURN: ACTION_REFEREE_RETURN,
} as const;

// ---------------------------------------------------------------- USDG (verified on-chain 2026-10-25)
export function usdgDomain(chainId: number, usdg: Address) {
  return { name: "Global Dollar", version: "1", chainId, verifyingContract: usdg } as const;
}

export const receiveWithAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Builds the typed data a sender signs for a gasless create (EIP-3009 receiveWithAuthorization). */
export function createAuthorizationTypedData(args: {
  chainId: number;
  usdg: Address;
  escrow: Address;
  from: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}) {
  return {
    domain: usdgDomain(args.chainId, args.usdg),
    types: receiveWithAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      from: args.from,
      to: args.escrow,
      value: args.value,
      validAfter: args.validAfter,
      validBefore: args.validBefore,
      nonce: args.nonce,
    },
  };
}
