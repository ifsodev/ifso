import { describe, expect, test, beforeEach } from "vitest";
import { encodeEventTopics, encodeAbiParameters, getAddress, type Address } from "viem";
import type { MineRow } from "@/lib/ifso/api";
import { clearOverlay, escrowEventsAbi, OVERLAY_TTL_MS, patchFor, patchFromLogs, patchRow, recordPatch, rowsForMode, withOverlay } from "@/lib/ifso/optimistic";
import { FLAG, STATUS_TEXT } from "@/lib/ifso/status";

// Found by the demo recordings (2026-11-01): after cancel the card kept "Waiting for its condition" + CANCEL and
// Refunds kept listing the payment until the index caught up.
const ESCROW: Address = getAddress("0x1111111111111111111111111111111111111111");
const ME: Address = getAddress("0x2222222222222222222222222222222222222222");
const BOB: Address = getAddress("0x4444444444444444444444444444444444444444");

const row = (over: Partial<MineRow> = {}): MineRow => ({
  id: "77",
  sender: ME.toLowerCase(),
  recipient: BOB.toLowerCase(),
  amount: "5000000",
  counterAmount: "0",
  kind: 1,
  status: 1,
  twoSided: false,
  accepted: false,
  voidOwed: 0,
  expiry: new Date(Date.now() + 86_400_000).toISOString(),
  acceptBy: null,
  createdTx: "0xabc",
  conditionHash: "0xdef",
  linkKey: null,
  ...over,
});

function log(eventName: "Cancelled" | "Approved" | "Released" | "Returned", id: bigint, extra: Record<string, unknown> = {}, address: Address = ESCROW) {
  const ev = escrowEventsAbi.find((e) => e.name === eventName)!;
  const topics = encodeEventTopics({ abi: [ev], eventName, args: { id, ...extra } as never });
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => (i.type === "uint256" ? 5_000_000n : i.type === "uint8" ? 0 : ME)) as never);
  return { address, topics, data } as never;
}

beforeEach(() => clearOverlay());

describe("confirmed transactions show at once, then the service wins", () => {
  test("cancel: the stale row reads Cancelled right away and leaves Refunds", () => {
    const patch = patchFromLogs([log("Cancelled", 77n, { to: ME })], ESCROW, "77");
    expect(patch).toEqual({ status: 6 });
    recordPatch("77", patch!);
    const stale = [row()];
    const shown = withOverlay(stale)!;
    expect(STATUS_TEXT[shown[0]!.status]).toBe("Cancelled");
    expect(rowsForMode(shown, "Refunds", ME)).toEqual([]);
    expect(rowsForMode(shown, "Sent", ME)).toHaveLength(1);
  });

  test("the overlay is dropped once the service reports the same state", () => {
    recordPatch("77", { status: 6 });
    expect(withOverlay([row({ status: 6 })])![0]!.status).toBe(6);
    expect(patchFor("77")).toBeUndefined();
  });

  test("it expires, and logs from another contract or another payment are ignored", () => {
    recordPatch("77", { status: 6 }, Date.now() - OVERLAY_TTL_MS - 1);
    expect(withOverlay([row()])![0]!.status).toBe(1);
    expect(patchFromLogs([log("Cancelled", 77n, { to: ME }, BOB)], ESCROW, "77")).toBeUndefined();
    expect(patchFromLogs([log("Cancelled", 78n, { to: ME })], ESCROW, "77")).toBeUndefined();
  });

  test("approve and release: the chain view gets the approval flag and the released status", () => {
    const p = patchFromLogs([log("Approved", 77n, { party: ME }), log("Released", 77n, { to: BOB })], ESCROW, "77")!;
    const view = patchRow({ status: 1, flags: FLAG.cancellable, sender: ME, recipient: BOB }, p);
    expect(view.status).toBe(3);
    expect(view.flags & FLAG.senderOk).toBeTruthy();
    const approvedOnly = patchRow({ status: 1, flags: 0, sender: ME, recipient: BOB }, patchFromLogs([log("Approved", 77n, { party: BOB })], ESCROW, "77"));
    expect(approvedOnly.status).toBe(1);
    expect(approvedOnly.flags & FLAG.recipientOk).toBeTruthy();
  });

  test("Refunds lists a voided payment only while a side is still owed", () => {
    expect(rowsForMode([row({ status: 5, voidOwed: 0 })], "Refunds", ME)).toEqual([]);
    expect(rowsForMode([row({ status: 5, voidOwed: 1 })], "Refunds", ME)).toHaveLength(1);
    expect(rowsForMode([row({ status: 1 })], "Refunds", ME)).toHaveLength(1);
  });
});
