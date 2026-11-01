import { describe, expect, test } from "bun:test";
import { feedsFor } from "../src/config/chain";

describe("feedsFor", () => {
  test("mainnet and any other chain use the five Chainlink proxies", () => {
    expect(feedsFor("4663", "ETH=0x6ba540c3638cac8047599dA9fB09c03BE834b725").map((f) => f.ticker)).toEqual(["ETH", "SPY", "NVDA", "TSLA", "AAPL"]);
    expect(feedsFor(undefined, undefined)).toHaveLength(5);
  });
  test("testnet uses only the feeds named in TESTNET_FEEDS", () => {
    const f = feedsFor("46630", " eth=0x6ba540c3638cac8047599dA9fB09c03BE834b725 ");
    expect(f).toEqual([{ ticker: "ETH", feed: "0x6ba540c3638cac8047599dA9fB09c03BE834b725", isStock: false, heartbeat: 86400 }]);
    expect(feedsFor("46630", undefined)).toEqual([]);
  });
  test("a malformed testnet entry fails at boot", () => {
    expect(() => feedsFor("46630", "ETH=0x123")).toThrow("TESTNET_FEEDS");
  });
});
