// Fixed inputs shared by test/parity.test.ts (TypeScript) and contracts/test/Vectors.t.sol (Solidity).
// If either side's encoding drifts, one of the two suites fails.
import type { Address, Hex } from "viem";
import { Kind, OP_GTE, PRICE_AT_DEADLINE, SRC_CHAINLINK, type Condition, type CreateParams } from "../../src/core/types";

export const V_SENDER = "0x00000000000000000000000000000000000a11ce" as Address;
export const V_RECIPIENT = "0x0000000000000000000000000000000000000b0b" as Address;
export const V_ACCEPTOR = "0x000000000000000000000000000000000000ac00" as Address;
export const V_SALT = ("0x" + "11".repeat(32)) as Hex;

export const V_CONDITION: Condition = {
  kind: Kind.PRICE,
  mode: PRICE_AT_DEADLINE,
  op: OP_GTE,
  source: SRC_CHAINLINK,
  target: "0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15",
  stockToken: "0x00000000000000000000000000000000000057cc",
  key: ("0x" + "00".repeat(32)) as Hex,
  threshold: 20_000_000_000n,
  multiplier: 1_000_000_000_000_000_000n,
  outcomeMask: 0n,
  start: 0n,
  deadline: 1_790_300_000n,
  maxStale: 90_000,
  holdWindow: 259_200,
};

export const V_PARAMS: CreateParams = {
  amount: 20_000_000n,
  counterAmount: 0n,
  recipient: V_RECIPIENT,
  linkKey: "0x0000000000000000000000000000000000000000",
  refundTo: "0x0000000000000000000000000000000000000000",
  altRefundTo: "0x0000000000000000000000000000000000000a17",
  expiry: 1_790_900_000n,
  acceptBy: 0n,
  twoSided: false,
  cancellable: true,
  salt: V_SALT,
  condition: V_CONDITION,
};
