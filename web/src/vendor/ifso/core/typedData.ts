// EIP-712 definitions shared by the web app, bot relayer and tests. Type strings MUST match the
// Solidity typehashes in IfsoEscrow.sol (checked by test/typedData.test.ts against the .sol source).
import type { Address, Hex } from "viem";
import { acceptAuthNonce } from "./condition";
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

/** What the claim-link key signs (the client does this; see core/link.signClaim). */
export function claimTypedData(a: { chainId: number; escrow: Address; id: bigint; recipient: Address; conditionHash: Hex }) {
  return { domain: ifsoDomain(a.chainId, a.escrow), types: claimTypes, primaryType: "Claim" as const, message: { id: a.id, recipient: a.recipient, conditionHash: a.conditionHash } };
}

/** What the claim-link key signs to let an acceptor join a link challenge. */
export function acceptTypedData(a: { chainId: number; escrow: Address; id: bigint; acceptor: Address; conditionHash: Hex }) {
  return { domain: ifsoDomain(a.chainId, a.escrow), types: acceptTypes, primaryType: "Accept" as const, message: { id: a.id, acceptor: a.acceptor, conditionHash: a.conditionHash } };
}

/** A wallet's relayed decision (tap OK / decline / referee). `nonce` = escrow.nonces(signer) read right before signing. */
export function decisionTypedData(a: { chainId: number; escrow: Address; id: bigint; action: number; nonce: bigint; deadline: bigint }) {
  return { domain: ifsoDomain(a.chainId, a.escrow), types: decisionTypes, primaryType: "Decision" as const, message: { id: a.id, action: a.action, nonce: a.nonce, deadline: a.deadline } };
}

/** The sender's relayed refund-address change. `nonce` = escrow.nonces(sender). */
export function refundRedirectTypedData(a: { chainId: number; escrow: Address; id: bigint; refundTo: Address; altRefundTo: Address; nonce: bigint; deadline: bigint }) {
  return { domain: ifsoDomain(a.chainId, a.escrow), types: refundRedirectTypes, primaryType: "RefundRedirect" as const, message: { id: a.id, refundTo: a.refundTo, altRefundTo: a.altRefundTo, nonce: a.nonce, deadline: a.deadline } };
}

/** EIP-2612 permit for the one-transaction create (`createWithPermit`, the sender's own wallet sends it). `nonce` = usdg.nonces(owner). */
export function createPermitTypedData(a: { chainId: number; usdg: Address; owner: Address; escrow: Address; value: bigint; nonce: bigint; deadline: bigint }) {
  return { domain: usdgDomain(a.chainId, a.usdg), types: permitTypes, primaryType: "Permit" as const, message: { owner: a.owner, spender: a.escrow, value: a.value, nonce: a.nonce, deadline: a.deadline } };
}

/** The acceptor's own USDG authorization for a gasless accept; the nonce binds it to this escrow, acceptor and refund address. */
export function acceptAuthorizationTypedData(a: { chainId: number; usdg: Address; escrow: Address; id: bigint; acceptor: Address; counterRefundTo: Address; counterAmount: bigint; validAfter: bigint; validBefore: bigint }) {
  return createAuthorizationTypedData({ chainId: a.chainId, usdg: a.usdg, escrow: a.escrow, from: a.acceptor, value: a.counterAmount, validAfter: a.validAfter, validBefore: a.validBefore, nonce: acceptAuthNonce(a.id, a.acceptor, a.counterRefundTo) });
}
