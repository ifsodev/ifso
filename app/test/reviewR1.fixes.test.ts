// Security review round 1, app fixes: regression tests beyond the PoCs in reviewR1.test.ts.
import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { createApp } from "../src/api/app";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter } from "../src/api/router";
import { clientIp, normaliseIp, trustedCountry } from "../src/api/clientIp";
import { loadEnv } from "../src/config/env";
import { BuildError, DEFAULTS, buildParams } from "../src/core/builder";
import { linkKeyAddress, signClaim } from "../src/core/link";
import { Kind, Status } from "../src/core/types";
import { polymarketCloseTime, polymarketLooksDecided, polymarketRefusal } from "../src/workers/resolver";
import { serialised } from "../src/workers/tx";
import type { Deps } from "../src/workers/deps";

const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const SENDER = "0x0000000000000000000000000000000000005e4d" as Address;
const OTHER = "0x0000000000000000000000000000000000000b0b" as Address;
const CH = ("0x" + "42".repeat(32)) as Hex;
const secret = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

function stubDeps(env: Record<string, string> = {}, escrow: Record<string, unknown> = {}) {
  const sent: Array<{ functionName: string; args: unknown[] }> = [];
  const e = { linkKey: linkKeyAddress(secret), sender: SENDER, recipient: OTHER, refundTo: SENDER, altRefundTo: ZERO, flags: 0, status: Status.OPEN, expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), amount: 20_000_000n, conditionHash: CH, ...escrow };
  const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" }, writeContract: async (req: { functionName: string; args: unknown[] }) => (sent.push(req), "0xabc" as Hex) };
  const deps = {
    env: loadEnv({ ESCROW_ADDRESS: ESCROW, ...env }),
    log: () => {},
    db: { insert: () => ({ values: async () => {} }) },
    clients: {
      chain: { id: 4663 },
      escrow: ESCROW,
      relayer: wallet,
      publicClient: {
        readContract: async ({ functionName }: { functionName: string }) => (functionName === "getEscrow" ? e : { kind: 1 }),
        simulateContract: async (req: unknown) => ({ request: req }),
        estimateContractGas: async () => 100_000n,
        getGasPrice: async () => 1_000_000n,
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
    },
  } as unknown as Deps;
  return { deps, sent };
}
const caller = (deps: Deps, ip = "203.0.113.7", limiter = new RateLimiter()) => appRouter.createCaller({ deps, limiter, ip, country: "DE" });

describe("R1-M6: client address and country come from the one trusted hop", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  test("none: headers are ignored, only the socket address counts", () => {
    expect(clientIp(h({ "x-forwarded-for": "9.9.9.9", "cf-connecting-ip": "8.8.8.8", "x-real-ip": "7.7.7.7" }), "none", "203.0.113.7")).toBe("203.0.113.7");
    expect(clientIp(h({}), "none", undefined)).toBe("unknown");
  });
  test("caddy: the LAST x-forwarded-for entry (the hop the proxy appended), never the first", () => {
    expect(clientIp(h({ "x-forwarded-for": "10.9.9.9, 1.1.1.1, 203.0.113.7" }), "caddy", "127.0.0.1")).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "not an ip" }), "caddy", "127.0.0.1")).toBe("127.0.0.1");
  });
  test("cloudflare reads cf-connecting-ip only; vercel reads x-real-ip, else the last xff entry", () => {
    expect(clientIp(h({ "cf-connecting-ip": "198.51.100.4", "x-forwarded-for": "1.2.3.4" }), "cloudflare", "127.0.0.1")).toBe("198.51.100.4");
    expect(clientIp(h({ "x-forwarded-for": "1.2.3.4" }), "cloudflare", "127.0.0.1")).toBe("127.0.0.1");
    expect(clientIp(h({ "x-real-ip": "198.51.100.9", "x-forwarded-for": "1.2.3.4" }), "vercel", "127.0.0.1")).toBe("198.51.100.9");
    expect(clientIp(h({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }), "vercel", "127.0.0.1")).toBe("5.6.7.8");
  });
  test("IPv6 is bucketed by /64; IPv4-mapped IPv6 is its IPv4 address", () => {
    const a = normaliseIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe(normaliseIp("2001:db8:1:2::1"));
    expect(a).not.toBe(normaliseIp("2001:db8:1:3::1"));
    expect(normaliseIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normaliseIp("::1")).toBe(normaliseIp("0:0:0:0:ffff::1"));
  });
  test("country: only the trusted proxy's own header; x-country and untrusted modes are unknown", () => {
    expect(trustedCountry(h({ "cf-ipcountry": "de" }), "cloudflare")).toBe("DE");
    expect(trustedCountry(h({ "cf-ipcountry": "DE" }), "vercel")).toBeUndefined();
    expect(trustedCountry(h({ "x-vercel-ip-country": "FR" }), "vercel")).toBe("FR");
    expect(trustedCountry(h({ "x-country": "DE", "cf-ipcountry": "DE", "x-vercel-ip-country": "DE" }), "none")).toBeUndefined();
    expect(trustedCountry(h({ "x-country": "DE" }), "caddy")).toBeUndefined();
    expect(trustedCountry(h({ "cf-ipcountry": "XX" }), "cloudflare")).toBeUndefined();
  });
  test("behind caddy a rotating first x-forwarded-for entry does not escape the claim limit, and real clients get their own buckets", async () => {
    const { deps, sent } = stubDeps({ CLAIM_RELAY_PER_IP_PER_HOUR: "2", TRUST_PROXY: "caddy" }, { recipient: ZERO });
    const app = createApp(deps, new RateLimiter());
    const signature = await signClaim({ secret, chainId: 4663, escrow: ESCROW, id: 9n, recipient: OTHER, conditionHash: CH });
    const claim = (xff: string) =>
      app.request("/trpc/claim", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": xff }, body: JSON.stringify({ id: "9", recipient: OTHER, signature }) });
    for (let i = 0; i < 8; i++) await claim(`10.0.${i}.1, 203.0.113.7`);
    expect(sent.length).toBe(2);
    await claim("10.0.0.1, 198.51.100.2"); // another real client: its own allowance
    expect(sent.length).toBe(3);
  });
  test("an IPv6 client rotating inside its /64 stays in one bucket", async () => {
    const { deps, sent } = stubDeps({ CLAIM_RELAY_PER_IP_PER_HOUR: "2", TRUST_PROXY: "cloudflare" }, { recipient: ZERO });
    const app = createApp(deps, new RateLimiter());
    const signature = await signClaim({ secret, chainId: 4663, escrow: ESCROW, id: 9n, recipient: OTHER, conditionHash: CH });
    for (let i = 0; i < 6; i++) {
      await app.request("/trpc/claim", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": `2001:db8:1:2:${i.toString(16)}::${i + 1}` }, body: JSON.stringify({ id: "9", recipient: OTHER, signature }) });
    }
    expect(sent.length).toBe(2);
  });
  test("behind cloudflare the country gate uses cf-ipcountry and ignores x-country", async () => {
    const { deps } = stubDeps({ TRUST_PROXY: "cloudflare" });
    const app = createApp(deps, new RateLimiter());
    const text = "/ifso @mia 100 if nvda closes above 200 by 2030-01-04";
    const ask = async (headers: Record<string, string>) => {
      const r = await app.request(`/trpc/parse?input=${encodeURIComponent(JSON.stringify({ text }))}`, { headers });
      return ((await r.json()) as { result: { data: { errors: string[] } } }).result.data.errors.join(" ");
    };
    expect(await ask({ "cf-ipcountry": "US", "x-country": "DE" })).toContain("aren't available in your region");
    expect(await ask({ "x-country": "DE" })).toContain("aren't available in your region"); // no edge header: unknown, blocked
    expect(await ask({ "cf-ipcountry": "DE" })).toBe("");
  });
});

describe("R1-M5: relayed calls refuse no-ops and are budgeted", () => {
  test("a repeat OK from the sender is refused before any gas is spent", async () => {
    const { deps, sent } = stubDeps({}, { flags: 8 }); // F_SENDER_OK already set
    await expect(caller(deps).decide({ id: "9", signer: SENDER, action: 1, deadline: "9999999999", signature: "0x01" })).rejects.toThrow("already recorded");
    expect(sent.length).toBe(0);
    // the recipient's OK is a different flag: still relayed
    await caller(deps).decide({ id: "9", signer: OTHER, action: 1, deadline: "9999999999", signature: "0x01" });
    expect(sent.length).toBe(1);
  });
  test("a redirect to the addresses already set is refused; a real change is relayed", async () => {
    const { deps, sent } = stubDeps();
    await expect(caller(deps).redirectRefund({ id: "9", refundTo: SENDER, altRefundTo: ZERO as Address, deadline: "9999999999", signature: "0x01" })).rejects.toThrow("already set");
    expect(sent.length).toBe(0);
    await caller(deps).redirectRefund({ id: "9", refundTo: OTHER, altRefundTo: ZERO as Address, deadline: "9999999999", signature: "0x01" });
    expect(sent.length).toBe(1);
  });
  test("per-escrow daily cap on decisions and redirects", async () => {
    const { deps, sent } = stubDeps({ RELAY_PER_ESCROW_PER_DAY: "3", RELAY_PER_SIGNER_PER_HOUR: "1000", RELAY_PER_IP_PER_HOUR: "1000" });
    const c = caller(deps);
    for (let i = 0; i < 10; i++) await c.decide({ id: "9", signer: OTHER, action: 2, deadline: "9999999999", signature: "0x01" }).catch(() => {});
    expect(sent.length).toBe(3);
    await caller(deps, "198.51.100.1").decide({ id: "10", signer: OTHER, action: 2, deadline: "9999999999", signature: "0x01" }); // another escrow is unaffected
    expect(sent.length).toBe(4);
  });
  test("per-signer budget holds across escrows and across client networks", async () => {
    const { deps, sent } = stubDeps({ RELAY_PER_SIGNER_PER_HOUR: "4", RELAY_PER_ESCROW_PER_DAY: "1000", RELAY_PER_IP_PER_HOUR: "1000" });
    const limiter = new RateLimiter();
    for (let i = 0; i < 12; i++) await caller(deps, `203.0.113.${i + 1}`, limiter).decide({ id: String(i), signer: OTHER, action: 2, deadline: "9999999999", signature: "0x01" }).catch(() => {});
    expect(sent.length).toBe(4);
  });
  test("per-network budget covers accept and the gasless create too", async () => {
    const { deps, sent } = stubDeps({ RELAY_PER_IP_PER_HOUR: "3", RELAY_PER_SIGNER_PER_HOUR: "1000", RELAY_PER_ESCROW_PER_DAY: "1000" });
    const c = caller(deps);
    for (let i = 0; i < 10; i++) await c.decide({ id: String(i), signer: OTHER, action: 2, deadline: "9999999999", signature: "0x01" }).catch(() => {});
    await c.accept({ id: "9", acceptor: OTHER, linkSig: "0x01", counterRefundTo: OTHER, validAfter: "0", validBefore: "9999999999", authSig: "0x01" }).catch(() => {});
    await c.submit({ params: {}, from: OTHER, validAfter: "0", validBefore: "9999999999", signature: "0x01" }).catch(() => {});
    expect(sent.length).toBe(3);
  });
  test("claims jump ahead of queued low-priority relays on the same key", async () => {
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const first = serialised("k", async () => (await gate.promise, order.push("running")));
    const lows = [1, 2, 3].map((i) => serialised("k", async () => void order.push(`low${i}`)));
    const claim = serialised("k", async () => void order.push("claim"), "high");
    gate.resolve();
    await Promise.all([first, ...lows, claim]);
    expect(order).toEqual(["running", "claim", "low1", "low2", "low3"]);
  });
});

describe("R1-I4: challenge acceptBy always satisfies the contract or the builder refuses", () => {
  const NOW = 1_790_000_000;
  const LINK = "0x0000000000000000000000000000000000001111" as const;
  const FEED = "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15" as const;
  const priceChallenge = (deadline: number) =>
    buildParams({ draft: { kind: "PRICE", ticker: "ETH", op: "GTE", priceUsd: "3000", mode: "AT_DEADLINE", deadline }, nowSec: NOW, amountUsdg: "10", twoSided: true, linkKey: LINK, feed: { feed: FEED, multiplier: 0n } });
  test("a deadline under two days away gets acceptBy strictly before it and at least 10 minutes out", () => {
    const p = priceChallenge(NOW + 3 * 3600);
    expect(p.acceptBy < p.condition.deadline).toBe(true);
    expect(Number(p.acceptBy)).toBeGreaterThanOrEqual(NOW + DEFAULTS.challengeMinAcceptWindow);
    expect(p.acceptBy < p.expiry).toBe(true);
  });
  test("a far deadline keeps the two day window", () => {
    expect(priceChallenge(NOW + 30 * 86400).acceptBy).toBe(BigInt(NOW + 2 * 86400));
  });
  test("a deadline closer than the minimum window is refused, not built", () => {
    expect(() => priceChallenge(NOW + 300)).toThrow(BuildError);
  });
  test("a fixture under two days away: acceptBy stays before kickoff minus the margin", () => {
    const kickoff = NOW + 20 * 3600;
    const p = buildParams({
      draft: { kind: "SPORTS", team: "arsenal", result: "WIN" } as never,
      nowSec: NOW, amountUsdg: "10", twoSided: true, linkKey: LINK,
      outcome: { resolver: ESCROW, questionId: CH, earliestResolve: kickoff + 9000, closeTime: kickoff, challengeMargin: DEFAULTS.sportsChallengeMargin, teamIsHome: true },
    });
    expect(p.condition.kind).toBe(Kind.OUTCOME);
    expect(Number(p.acceptBy)).toBe(kickoff - DEFAULTS.sportsChallengeMargin);
    expect(() =>
      buildParams({ draft: { kind: "SPORTS", team: "arsenal", result: "WIN" } as never, nowSec: NOW, amountUsdg: "10", twoSided: true, linkKey: LINK, outcome: { resolver: ESCROW, questionId: CH, earliestResolve: NOW + 1100 + 9000, closeTime: NOW + 1100, teamIsHome: true } }),
    ).toThrow(BuildError); // kickoff in 18 min: nothing left after the margin and the minimum window
  });
});

describe("R1-L3: Polymarket close time is the earliest signal; allow-list", () => {
  const env = { POLYMARKET_MIN_LIQUIDITY_USD: 5000, POLYMARKET_MIN_VOLUME_USD: 25000, POLYMARKET_MAX_DAYS_OUT: 60 };
  const NOW = Math.floor(Date.now() / 1000);
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const market = (o: Record<string, unknown> = {}) => ({ slug: "m", question: "Will it?", conditionId: CH, closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', endDate: iso(NOW + 7 * 86400), liquidityNum: 20000, volumeNum: 90000, ...o }) as never;
  test("closeTime is min(endDate, closedTime)", () => {
    expect(polymarketCloseTime(market({ closedTime: iso(NOW + 2 * 86400) }))).toBe(Math.floor(new Date(iso(NOW + 2 * 86400)).getTime() / 1000));
    expect(polymarketCloseTime(market({ closedTime: iso(NOW + 9 * 86400) }))).toBe(Math.floor(new Date(iso(NOW + 7 * 86400)).getTime() / 1000));
    expect(polymarketCloseTime(market({ endDate: undefined }))).toBeUndefined();
  });
  test("allow-list: closed, inactive, non-binary, thin, quiet, too soon and too far are refused; a normal market passes", () => {
    expect(polymarketRefusal(market(), env, NOW)).toBeUndefined();
    expect(polymarketRefusal(market({ closed: true }), env, NOW)).toContain("closed");
    expect(polymarketRefusal(market({ active: false }), env, NOW)).toContain("not active");
    expect(polymarketRefusal(market({ outcomes: '["A","B","C"]' }), env, NOW)).toContain("Yes/No");
    expect(polymarketRefusal(market({ liquidityNum: 10 }), env, NOW)).toContain("liquidity");
    expect(polymarketRefusal(market({ liquidityNum: undefined }), env, NOW)).toContain("liquidity");
    expect(polymarketRefusal(market({ volumeNum: 10 }), env, NOW)).toContain("volume");
    expect(polymarketRefusal(market({ endDate: iso(NOW + 600) }), env, NOW)).toContain("too soon");
    expect(polymarketRefusal(market({ endDate: iso(NOW + 90 * 86400) }), env, NOW)).toContain("60 days");
    expect(polymarketRefusal(market({ endDate: iso(NOW + 30 * 86400), closedTime: iso(NOW + 600) }), env, NOW)).toContain("too soon"); // its own earlier close signal wins
  });
  test("a market priced outside 2..98% is not offered as a challenge", () => {
    expect(polymarketLooksDecided(market({ outcomePrices: '["0.99","0.01"]' }))).toBe(true);
    expect(polymarketLooksDecided(market({ outcomePrices: '["0.01","0.99"]' }))).toBe(true);
    expect(polymarketLooksDecided(market({ outcomePrices: '["0.5","0.5"]' }))).toBe(false);
    expect(polymarketLooksDecided(market({ outcomePrices: "garbage" }))).toBe(true);
  });
  test("Polymarket challenges close a day before the creation-time endDate", () => {
    const end = NOW + 10 * 86400;
    const p = buildParams({ draft: { kind: "MARKET", venue: "polymarket", ref: "x", answer: "YES" } as never, nowSec: NOW, amountUsdg: "10", twoSided: true, linkKey: "0x0000000000000000000000000000000000001111", outcome: { resolver: ESCROW, questionId: CH, earliestResolve: end, closeTime: end, challengeMargin: DEFAULTS.polymarketChallengeMargin } });
    expect(Number(p.acceptBy)).toBe(NOW + 2 * 86400); // default window is the earlier bound here
    const soon = NOW + 30 * 3600;
    const q = buildParams({ draft: { kind: "MARKET", venue: "polymarket", ref: "x", answer: "YES" } as never, nowSec: NOW, amountUsdg: "10", twoSided: true, linkKey: "0x0000000000000000000000000000000000001111", outcome: { resolver: ESCROW, questionId: CH, earliestResolve: soon, closeTime: soon, challengeMargin: DEFAULTS.polymarketChallengeMargin } });
    expect(Number(q.acceptBy)).toBe(soon - 86400);
  });
});

describe("todo 11b: a NoChange revert is a refusal, not a send", () => {
  const noChange = () => Object.assign(new Error("reverted"), { shortMessage: 'The contract function "decideBySig" reverted with the following signature: NoChange()' });
  test("a decision or redirect that races a state change and reverts NoChange in the simulation is a 400 with no transaction", async () => {
    const { deps, sent } = stubDeps();
    (deps.clients.publicClient as unknown as { simulateContract: () => Promise<never> }).simulateContract = async () => {
      throw noChange();
    };
    await expect(caller(deps).decide({ id: "9", signer: OTHER, action: 1, deadline: "9999999999", signature: "0x01" })).rejects.toThrow("would not change anything");
    await expect(caller(deps).redirectRefund({ id: "9", refundTo: OTHER, altRefundTo: ZERO as Address, deadline: "9999999999", signature: "0x01" })).rejects.toThrow("would not change anything");
    expect(sent.length).toBe(0);
  });
});

describe("todo 11b: challenge builder honours acceptBy + maxStale < deadline", () => {
  const NOW = 1_790_000_000;
  const LINK = "0x0000000000000000000000000000000000001111" as const;
  const FEED = "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15" as const;
  const mk = (deadline: number, twoSided: boolean, mode: "AT_DEADLINE" | "TOUCH" = "AT_DEADLINE") =>
    buildParams({ draft: { kind: "PRICE", ticker: "ETH", op: "GTE", priceUsd: "3000", mode, deadline }, nowSec: NOW, amountUsdg: "10", twoSided, linkKey: LINK, feed: { feed: FEED, multiplier: 0n } });
  test("a challenge uses the short freshness and the contract inequality holds across deadlines", () => {
    for (const hours of [2, 3, 5, 12, 47, 49, 24 * 30]) {
      const p = mk(NOW + hours * 3600, true);
      expect(p.condition.maxStale).toBe(DEFAULTS.challengeMaxStale);
      expect(p.acceptBy + BigInt(p.condition.maxStale) < p.condition.deadline).toBe(true);
      expect(Number(p.acceptBy)).toBeGreaterThanOrEqual(NOW + DEFAULTS.challengeMinAcceptWindow);
    }
  });
  test("a one-sided payment keeps the long freshness", () => {
    expect(mk(NOW + 3 * 3600, false).condition.maxStale).toBe(DEFAULTS.maxStale);
  });
  test("a deadline too close for freshness + the 10 minute minimum is refused", () => {
    expect(() => mk(NOW + DEFAULTS.challengeMaxStale + DEFAULTS.challengeMinAcceptWindow, true)).toThrow(BuildError);
    expect(() => mk(NOW + DEFAULTS.challengeMaxStale + DEFAULTS.challengeMinAcceptWindow + 2, true)).not.toThrow();
  });
  test("a two-sided TOUCH is refused by the builder", () => {
    expect(() => mk(NOW + 86400, true, "TOUCH")).toThrow(BuildError);
    expect(() => mk(NOW + 86400, false, "TOUCH")).not.toThrow();
  });
});
