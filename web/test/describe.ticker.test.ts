import { describe, expect, test } from "vitest";
import { describeOnChainCondition } from "@/lib/ifso/describe";

// Found by the demo recordings (2026-11-01): claim and challenge pages said "the price on feed 0x6ba5…b725".
const price = { kind: 2, mode: 0, op: 0, threshold: "200000000000", deadline: "1800000000", target: "0x6bA500000000000000000000000000000000b725" };

describe("claim and challenge pages name the ticker", () => {
  test("at the deadline and touch", () => {
    const at = describeOnChainCondition(price, "ETH");
    expect(at).toMatch(/^It unlocks if ETH is at or above 2,000 at /);
    expect(at).not.toContain("feed");
    expect(describeOnChainCondition({ ...price, mode: 1, op: 1, start: "1700000000" }, "ETH")).toMatch(/^It unlocks if ETH reaches at or below 2,000 between /);
  });
  test("an unknown feed still reads, by its address", () => {
    expect(describeOnChainCondition(price)).toMatch(/the price on feed 0x6bA5/);
  });
});
