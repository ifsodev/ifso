// Testnet run 2026-11-01: while the owner had paused creation, the live API refused a gasless create with
// "The contract function "createWithAuthorization" reverted." and a gasless accept the same way. The RPC returned the
// revert data (CreationIsPaused) and the ABI knows the error, but shortError() kept only viem's shortMessage, so the
// site could not tell the person WHY. The decoded reason must reach the caller, in plain words for the common ones.
import { describe, expect, test } from "bun:test";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { ifsoEscrowAbi } from "../src/abi";
import { shortError } from "../src/workers/tx";

const reverted = (errorName: string, functionName = "createWithAuthorization") => {
  const data = encodeErrorResult({ abi: ifsoEscrowAbi, errorName } as never);
  const cause = new ContractFunctionRevertedError({ abi: ifsoEscrowAbi, data, functionName });
  return new ContractFunctionExecutionError(cause, { abi: ifsoEscrowAbi, functionName, args: [] });
};

describe("relay refusals carry the contract's reason", () => {
  test("a paused create says creation is paused, not just 'reverted'", () => {
    const m = shortError(reverted("CreationIsPaused"));
    expect(m).toMatch(/paused/i);
    expect(m).not.toMatch(/^The contract function .* reverted\.$/);
  });
  test("a paused accept says the same", () => {
    expect(shortError(reverted("CreationIsPaused", "acceptWithAuthorization"))).toMatch(/paused/i);
  });
  test("a known error comes out in plain words", () => {
    expect(shortError(reverted("AcceptWindowClosed", "acceptWithAuthorization"))).toMatch(/AcceptWindowClosed|time to accept/i);
  });
  test("an error without plain words still names the reason", () => {
    expect(shortError(reverted("UseDecision", "settle"))).toMatch(/reverted: UseDecision$/);
  });
  test("NoChange keeps its plain answer", () => {
    expect(shortError(reverted("NoChange", "decideBySig"))).toBe("this would not change anything, so it was not sent");
  });
  test("non-contract errors are unchanged", () => {
    expect(shortError(new Error("network down"))).toBe("network down");
  });
});
