import { beforeEach, describe, expect, test } from "vitest";
import { getAddress, type Address } from "viem";
import type { MineRow } from "@/lib/ifso/api";
import { clearOverlay, recordCreated, rowFromBuild, rowsForMode, withOverlay } from "@/lib/ifso/optimistic";
import { realBuildAnswer, SENDER } from "./helpers";

// Found by the demo recordings (2026-11-01): right after "It is on its way" the new payment was missing from Sent,
// so "Details" on the top row opened an older payment.
const BOB: Address = getAddress("0x4444444444444444444444444444444444444444");
const older: MineRow = {
  id: "1",
  sender: SENDER.toLowerCase(),
  recipient: BOB.toLowerCase(),
  amount: "3000000",
  counterAmount: "0",
  kind: 1,
  status: 1,
  twoSided: false,
  accepted: false,
  voidOwed: 0,
  expiry: "2026-12-01T00:00:00.000Z",
  acceptBy: null,
  createdTx: "0x01",
  conditionHash: "0x02",
  linkKey: null,
};

beforeEach(() => clearOverlay());

describe("a payment just created is in Sent at once", () => {
  test("it is the top row before the service has indexed it, with its own id", () => {
    const answer = realBuildAnswer({ recipient: BOB, amountUsdg: "5" });
    recordCreated(rowFromBuild(answer.id, "0xfeed", SENDER, answer.params));
    const sent = rowsForMode(withOverlay([older], SENDER)!, "Sent", SENDER);
    expect(sent.map((r) => r.id)).toEqual([answer.id, "1"]);
    expect(sent[0]).toMatchObject({ amount: "5000000", recipient: BOB.toLowerCase(), status: 1, kind: 1, createdTx: "0xfeed" });
  });

  test("a claim-link payment has no recipient yet", () => {
    const answer = realBuildAnswer();
    const r = rowFromBuild(answer.id, "0xfeed", SENDER, answer.params);
    expect(r.recipient).toBeNull();
    expect(r.linkKey).not.toBeNull();
  });

  test("once the service lists it, its row is used and it is not shown twice", () => {
    const answer = realBuildAnswer({ recipient: BOB });
    recordCreated(rowFromBuild(answer.id, "0xfeed", SENDER, answer.params));
    const indexed = { ...older, id: answer.id, status: 6 };
    const rows = withOverlay([indexed, older], SENDER)!;
    expect(rows.map((r) => r.id)).toEqual([answer.id, "1"]);
    expect(rows[0]!.status).toBe(6);
    expect(withOverlay([older], SENDER)!.map((r) => r.id)).toEqual(["1"]); // dropped for good once indexed
  });

  test("another wallet's list never shows it", () => {
    const answer = realBuildAnswer({ recipient: BOB });
    recordCreated(rowFromBuild(answer.id, "0xfeed", SENDER, answer.params));
    expect(withOverlay([], getAddress("0x5555555555555555555555555555555555555555"))).toEqual([]);
  });
});
