import { describe, expect, test } from "bun:test";
import { DEFAULTS, buildParams } from "../src/core/builder";
import { feedUnitsToUnderlying, underlyingToFeedUnits } from "../src/core/condition";
import { feeFor, formatUsdg, parseUsdg } from "../src/core/money";
import { countryFromHeaders, stockPriceConditionAllowed } from "../src/core/geo";
import { Kind, PRICE_AT_DEADLINE, PRICE_TOUCH } from "../src/core/types";
import { matchFixtures, normTeam } from "../src/api/fixtures";

const NOW = 1_790_000_000;
const FEED = "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15" as const;
const TOKEN = "0x00000000000000000000000000000000000057cc" as const;
const LINK = "0x0000000000000000000000000000000000001111" as const;

describe("multiplier applied exactly once", () => {
  test("underlying -> feed units", () => {
    expect(underlyingToFeedUnits("200", 10n ** 18n)).toBe(200_00000000n);
    expect(underlyingToFeedUnits("200", 2n * 10n ** 18n)).toBe(400_00000000n); // feed = underlying x multiplier
    expect(underlyingToFeedUnits("199.995", 10n ** 18n)).toBe(199_99500000n);
    expect(feedUnitsToUnderlying(400_00000000n, 2n * 10n ** 18n)).toBe(200);
    expect(() => underlyingToFeedUnits("2e3", 10n ** 18n)).toThrow();
  });

  test("PRICE AT_DEADLINE params", () => {
    const p = buildParams({
      draft: { kind: "PRICE", ticker: "NVDA", op: "GTE", priceUsd: "200", mode: "AT_DEADLINE", deadline: NOW + 86400 },
      nowSec: NOW,
      amountUsdg: "100",
      twoSided: false,
      linkKey: LINK,
      feed: { feed: FEED, stockToken: TOKEN, multiplier: 15n * 10n ** 17n },
    });
    expect(p.condition.kind).toBe(Kind.PRICE);
    expect(p.condition.mode).toBe(PRICE_AT_DEADLINE);
    expect(p.condition.threshold).toBe(300_00000000n); // 200 x 1.5
    expect(p.condition.multiplier).toBe(15n * 10n ** 17n);
    expect(p.condition.maxStale).toBe(DEFAULTS.maxStale);
    expect(p.expiry).toBe(BigInt(NOW + 86400 + DEFAULTS.holdWindow + DEFAULTS.priceSettleWindow));
    expect(p.amount).toBe(100_000000n);
  });

  test("TOUCH params start now, short grace", () => {
    const p = buildParams({ draft: { kind: "PRICE", ticker: "ETH", op: "LTE", priceUsd: "2000", mode: "TOUCH", deadline: NOW + 86400 }, nowSec: NOW, amountUsdg: "5", twoSided: false, linkKey: LINK, feed: { feed: FEED, multiplier: 0n } });
    expect(p.condition.mode).toBe(PRICE_TOUCH);
    expect(p.condition.start).toBe(BigInt(NOW));
    expect(p.condition.multiplier).toBe(0n);
    expect(p.condition.stockToken).toBe("0x0000000000000000000000000000000000000000");
    expect(p.condition.maxStale).toBe(0);
  });
});

describe("builder rules", () => {
  test("exactly one of recipient / link", () => {
    expect(() => buildParams({ draft: { kind: "TIME", at: NOW + 100 }, nowSec: NOW, amountUsdg: "5", twoSided: false })).toThrow();
  });
  test("challenge: counter amount, acceptBy before expiry, never cancellable", () => {
    const p = buildParams({ draft: { kind: "APPROVE", mode: "REFEREE", referee: { type: "handle", handle: "r" } }, referee: "0x0000000000000000000000000000000000000eef", nowSec: NOW, amountUsdg: "10", counterAmountUsdg: "15", twoSided: true, linkKey: LINK, cancellable: true });
    expect(p.counterAmount).toBe(15_000000n);
    expect(p.cancellable).toBe(false);
    expect(p.acceptBy > 0n && p.acceptBy < p.expiry).toBe(true);
  });
  test("outcome mask from fixture side", () => {
    const p = buildParams({ draft: { kind: "SPORTS", team: "arsenal", result: "WIN" }, nowSec: NOW, amountUsdg: "20", twoSided: false, linkKey: LINK, outcome: { resolver: FEED, questionId: ("0x" + "22".repeat(32)) as `0x${string}`, earliestResolve: NOW + 9000, teamIsHome: false } });
    expect(p.condition.outcomeMask).toBe(4n);
    expect(p.expiry).toBe(BigInt(NOW + 9000 + DEFAULTS.outcomeWindow));
  });
});

describe("money, fees, geo", () => {
  test("USDG 6 decimals", () => {
    expect(parseUsdg("0.25")).toBe(250_000n);
    expect(formatUsdg(20_250_000n)).toBe("20.25");
    expect(() => parseUsdg("1.0000001")).toThrow();
  });
  test("flat fees only", () => {
    expect(feeFor(Kind.TIME, 250_000n, 500_000n)).toBe(250_000n);
    expect(feeFor(Kind.OUTCOME, 250_000n, 500_000n)).toBe(750_000n);
  });
  test("stock price conditions gated in UK/CH only (US, CA, AE open: DECISIONS #41); unknown fails closed", () => {
    for (const c of ["GB", "CH"]) expect(stockPriceConditionAllowed(c)).toBe(false);
    for (const c of ["US", "CA", "AE"]) expect(stockPriceConditionAllowed(c)).toBe(true);
    expect(stockPriceConditionAllowed("DE")).toBe(true);
    expect(stockPriceConditionAllowed(undefined)).toBe(false);
    expect(countryFromHeaders(new Headers({ "cf-ipcountry": "ae" }))).toBe("AE");
    expect(countryFromHeaders(new Headers({ "cf-ipcountry": "XX" }))).toBeUndefined();
  });
});

describe("fixture matching", () => {
  const ev = (id: string, h: string, a: string, t: number) => ({ id, sport_key: "soccer_epl", commence_time: new Date(t * 1000).toISOString(), home_team: h, away_team: a });
  const events = [ev("1", "Chelsea", "Arsenal", NOW + 86400), ev("2", "Arsenal", "Everton", NOW + 8 * 86400), ev("0", "Arsenal", "Spurs", NOW - 100)];
  test("next upcoming fixture for the team", () => {
    expect(matchFixtures(events, "arsenal", undefined, undefined, NOW)[0]!.id).toBe("1");
    expect(matchFixtures(events, "arsenal", "everton", undefined, NOW)[0]!.id).toBe("2");
    expect(matchFixtures(events, "Arsenal FC", undefined, NOW + 8 * 86400, NOW)[0]!.id).toBe("2");
  });
  test("normTeam", () => expect(normTeam("Arsenal F.C.")).toBe(normTeam("arsenal")));
  test("outcome expiry never falls below the evaluator minimum (R2-L2)", () => {
    const base = { draft: { kind: "SPORTS", team: "arsenal", result: "WIN" } as const, nowSec: NOW, amountUsdg: "20", twoSided: false, linkKey: LINK };
    const o = { resolver: FEED, questionId: ("0x" + "22".repeat(32)) as `0x${string}`, earliestResolve: NOW + 9000, teamIsHome: false };
    // default window already covers PROPOSAL_GRACE (2 d) + dispute + panel + claim here: unchanged
    expect(buildParams({ ...base, outcome: { ...o, minSpan: 5 * 86400 } }).expiry).toBe(BigInt(NOW + 9000 + DEFAULTS.outcomeWindow));
    // a longer on-chain minimum wins over the 7 d default
    expect(buildParams({ ...base, outcome: { ...o, minSpan: 9 * 86400 } }).expiry).toBe(BigInt(NOW + 9000 + 9 * 86400));
  });
});
