import { describe, expect, test } from "bun:test";
import { escrowView } from "../src/api/router";
import { feedsFor, tickerForFeed } from "../src/config/chain";
import { Kind } from "../src/core/types";

// Found by the demo recordings (2026-11-01): claim and challenge pages said "the price on feed 0x6ba5…b725".
const MOCK = "0x6bA500000000000000000000000000000000b725";
const testnet = feedsFor("46630", `ETH=${MOCK}`);
const mainnet = feedsFor("4663", undefined);

describe("escrow answer names the ticker of a price condition's feed", () => {
  test("testnet mock feed (TESTNET_FEEDS) and every mainnet feed", () => {
    expect(tickerForFeed(MOCK.toLowerCase(), testnet)).toBe("ETH");
    for (const f of mainnet) expect(tickerForFeed(f.feed.toLowerCase(), mainnet)).toBe(f.ticker);
    expect(tickerForFeed("0x0000000000000000000000000000000000000001", mainnet)).toBeUndefined();
  });

  test("the escrow query carries it; other kinds and unknown feeds carry none", () => {
    const v = escrowView({ amount: 5_000_000n }, { kind: Kind.PRICE, target: MOCK.toLowerCase() }, testnet) as { ticker?: string; amountText: string };
    expect(v.ticker).toBe("ETH");
    expect(v.amountText).toBeTruthy();
    const nvda = mainnet.find((f) => f.ticker === "NVDA")!;
    expect((escrowView({ amount: 1n }, { kind: Kind.PRICE, target: nvda.feed }, mainnet) as { ticker?: string }).ticker).toBe("NVDA");
    expect((escrowView({ amount: 1n }, { kind: Kind.TIME, target: MOCK }, testnet) as { ticker?: string }).ticker).toBeUndefined();
    expect((escrowView({ amount: 1n }, { kind: Kind.PRICE, target: "0x0000000000000000000000000000000000000001" }, testnet) as { ticker?: string }).ticker).toBeUndefined();
  });
});
