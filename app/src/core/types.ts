// Mirrors contracts/src/libraries/IfsoTypes.sol. Keep field order IDENTICAL: the condition hash is
// keccak256(abi.encode(Condition)) and link signatures commit to it.
import type { Address, Hex } from "viem";

export enum Kind {
  NONE = 0,
  TIME = 1,
  PRICE = 2,
  APPROVE = 3,
  OUTCOME = 4,
}

export enum Verdict {
  PENDING = 0,
  TRUE = 1,
  FALSE = 2,
  VOID = 3,
}

export enum Status {
  NONE = 0,
  OPEN = 1,
  MET = 2,
  RELEASED = 3,
  RETURNED = 4,
  VOIDED = 5,
  CANCELLED = 6,
}

export const PRICE_AT_DEADLINE = 0;
export const PRICE_TOUCH = 1;
export const OP_GTE = 0;
export const OP_LTE = 1;
export const SRC_CHAINLINK = 0;
export const SRC_PYTH = 1;
export const APPROVE_PARTIES = 0;
export const APPROVE_REFEREE = 1;

export const ACTION_OK = 1;
export const ACTION_DECLINE = 2;
export const ACTION_REFEREE_RELEASE = 3;
export const ACTION_REFEREE_RETURN = 4;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const ZERO_BYTES32 = ("0x" + "00".repeat(32)) as Hex;

export interface Condition {
  kind: Kind;
  mode: number;
  op: number;
  source: number;
  target: Address;
  stockToken: Address;
  key: Hex;
  threshold: bigint; // 8-decimal feed units
  multiplier: bigint; // uiMultiplier snapshot (1e18 scale) or 0
  outcomeMask: bigint;
  start: bigint;
  deadline: bigint;
  maxStale: number;
  holdWindow: number;
}

export interface CreateParams {
  amount: bigint; // USDG 6 decimals
  counterAmount: bigint;
  recipient: Address;
  linkKey: Address;
  refundTo: Address;
  altRefundTo: Address;
  expiry: bigint;
  acceptBy: bigint;
  twoSided: boolean;
  cancellable: boolean;
  salt: Hex;
  condition: Condition;
}

export function emptyCondition(): Condition {
  return {
    kind: Kind.NONE,
    mode: 0,
    op: 0,
    source: 0,
    target: ZERO_ADDRESS,
    stockToken: ZERO_ADDRESS,
    key: ZERO_BYTES32,
    threshold: 0n,
    multiplier: 0n,
    outcomeMask: 0n,
    start: 0n,
    deadline: 0n,
    maxStale: 0,
    holdWindow: 0,
  };
}

/** ABI tuple components, in Solidity declaration order. */
export const conditionComponents = [
  { name: "kind", type: "uint8" },
  { name: "mode", type: "uint8" },
  { name: "op", type: "uint8" },
  { name: "source", type: "uint8" },
  { name: "target", type: "address" },
  { name: "stockToken", type: "address" },
  { name: "key", type: "bytes32" },
  { name: "threshold", type: "int256" },
  { name: "multiplier", type: "uint256" },
  { name: "outcomeMask", type: "uint256" },
  { name: "start", type: "uint64" },
  { name: "deadline", type: "uint64" },
  { name: "maxStale", type: "uint32" },
  { name: "holdWindow", type: "uint32" },
] as const;

export const createParamsComponents = [
  { name: "amount", type: "uint96" },
  { name: "counterAmount", type: "uint96" },
  { name: "recipient", type: "address" },
  { name: "linkKey", type: "address" },
  { name: "refundTo", type: "address" },
  { name: "altRefundTo", type: "address" },
  { name: "expiry", type: "uint64" },
  { name: "acceptBy", type: "uint64" },
  { name: "twoSided", type: "bool" },
  { name: "cancellable", type: "bool" },
  { name: "salt", type: "bytes32" },
  { name: "condition", type: "tuple", components: conditionComponents },
] as const;
