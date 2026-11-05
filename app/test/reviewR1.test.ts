// Security review round 1: service PoCs. Each test asserts the SAFE behaviour and FAILS on main 6fe2c16.
import { afterEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { createApp } from "../src/api/app";
import { appRouter } from "../src/api/router";
import { RateLimiter } from "../src/api/rateLimit";
import { loadEnv } from "../src/config/env";
import { linkKeyAddress, signClaim } from "../src/core/link";
import { Status } from "../src/core/types";
import { keeperTick } from "../src/workers/keeper";
import type { Deps } from "../src/workers/deps";

const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const RESOLVER = "0x00000000000000000000000000000000000e5c21" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const CH = ("0x" + "42".repeat(32)) as Hex;
const secret = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const SENDER = "0x0000000000000000000000000000000000005e4d" as Address;

/** Stub chain + DB: every simulation succeeds, every write is counted. */
function stubDeps(env: Record<string, string> = {}) {
  const sent: Array<{ functionName: string; args: unknown[] }> = [];
  const e = { linkKey: linkKeyAddress(secret), flags: 0, status: Status.OPEN, recipient: ZERO, expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), amount: 20_000_000n, conditionHash: CH };
  const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" }, writeContract: async (req: { functionName: string; args: unknown[] }) => (sent.push(req), "0xabc" as Hex) };
  const chainSel = () => {
    const q: any = { from: () => q, where: () => q, orderBy: () => q, limit: async () => [], then: (r: (v: unknown[]) => unknown) => r([]) };
    return q;
  };
  const deps = {
    env: loadEnv({ ESCROW_ADDRESS: ESCROW, RESOLVER_ADDRESS: RESOLVER, ...env }),
    log: () => {},
    db: { insert: () => ({ values: () => ({ onConflictDoNothing: async () => {}, then: (r: () => unknown) => r() }) }), select: chainSel, update: () => ({ set: () => ({ where: async () => {} }) }) },
    clients: {
      chain: { id: 4663 },
      escrow: ESCROW,
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      resolverContract: RESOLVER,
      relayer: wallet,
      resolver: wallet,
      keeper: wallet,
      publicClient: {
        readContract: async ({ functionName }: { functionName: string }) => (functionName === "getEscrow" ? e : functionName === "feeFor" ? 750_000n : { kind: 1 }),
        simulateContract: async (req: unknown) => ({ request: req }),
        estimateContractGas: async () => 100_000n,
        getGasPrice: async () => 1_000_000n,
        getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
    },
  } as unknown as Deps;
  return { deps, sent };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("R1-M6: client-chosen IP and country headers", () => {
  test("claim relay limit cannot be bypassed by rotating cf-connecting-ip / x-forwarded-for", async () => {
    const { deps, sent } = stubDeps({ CLAIM_RELAY_PER_IP_PER_HOUR: "2" });
    const app = createApp(deps, new RateLimiter());
    const signature = await signClaim({ secret, chainId: 4663, escrow: ESCROW, id: 9n, recipient: "0x0000000000000000000000000000000000000b0b", conditionHash: CH });
    for (let i = 0; i < 10; i++) {
      // the attacker's real address is 203.0.113.7; Caddy appends it AFTER the client-supplied value
      await app.request("/trpc/claim", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.${i}.1, 203.0.113.7` },
        body: JSON.stringify({ id: "9", recipient: "0x0000000000000000000000000000000000000b0b", signature }),
      });
    }
    expect(sent.length).toBeLessThanOrEqual(2); // fails: 10 relayed claims from one client
  });

  test("stock price region gate cannot be bypassed with a self-set x-country header", async () => {
    const { deps } = stubDeps();
    const app = createApp(deps, new RateLimiter());
    const text = "/ifso @mia 100 if nvda closes above 200 by 2030-01-04";
    const r = await app.request(`/trpc/parse?input=${encodeURIComponent(JSON.stringify({ text }))}`, { headers: { "x-country": "DE" } }); // a US user
    const body = (await r.json()) as { result: { data: { errors: string[] } } };
    expect(body.result.data.errors.join(" ")).toContain("aren't available in your region"); // fails: allowed
  });
});

describe("R1-M7: unauthenticated build registers on-chain questions for any Polymarket slug", () => {
  test("a stranger cannot make the resolver key register 25 questions (gas + a 100 USDG bond each at end date)", async () => {
    const { deps, sent } = stubDeps();
    const end = new Date(Date.now() + 3 * 86400_000).toISOString();
    globalThis.fetch = (async (url: string) => {
      const slug = new URL(String(url)).searchParams.get("slug");
      const body = JSON.stringify([{ slug, question: `q ${slug}`, conditionId: "0x" + "11".repeat(32), closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', endDate: end }]);
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const caller = appRouter.createCaller({ deps, limiter: new RateLimiter(), ip: "203.0.113.7", country: "DE" });
    for (let i = 0; i < 25; i++) {
      await caller.build({ text: `/ifso @sam 10 if https://polymarket.com/event/spam-market-${i} resolves yes`, sender: SENDER, linkKey: "0x000000000000000000000000000000000000c0de" }).catch(() => {});
    }
    const creates = sent.filter((s) => s.functionName === "createQuestion").length;
    expect(creates).toBeLessThanOrEqual(3); // fails: 25 createQuestion txs, no auth, no rate limit, no escrow needed
  });
});

describe("polymarket.com links in build: the market is the last segment; an event alone is looked up", () => {
  const end = () => new Date(Date.now() + 3 * 86400_000).toISOString();
  const market = (slug: string, closed = false) => ({ slug, question: `q ${slug}`, groupItemTitle: slug.toUpperCase(), conditionId: "0x" + "11".repeat(32), closed, active: true, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', endDate: end(), liquidityNum: 1e6, volumeNum: 1e6 });
  function stub() {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const u = new URL(String(url));
      seen.push(u.pathname + u.search);
      if (u.pathname === "/events") {
        const slug = u.searchParams.get("slug");
        const body = slug === "btc-nov" ? [{ slug, title: "Bitcoin in November?", closed: false, markets: [market("btc-95k"), market("btc-90k"), market("btc-60k", true)] }] : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }
      const m = u.pathname.match(/^\/markets\/slug\/(.+)$/);
      if (m && m[1]!.startsWith("btc-9")) return new Response(JSON.stringify(market(m[1]!)), { status: 200 });
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as typeof fetch;
    return seen;
  }
  const build = (link: string) =>
    appRouter.createCaller({ deps: stubDeps().deps, limiter: new RateLimiter(), ip: "203.0.113.9", country: "DE" }).build({ text: `/ifso @sam 10 if ${link} resolves yes`, sender: SENDER, linkKey: "0x000000000000000000000000000000000000c0de" });

  test("/event/<event>/<market> reads the market, never the event slug", async () => {
    const seen = stub();
    await build("https://polymarket.com/event/btc-nov/btc-95k").catch(() => {});
    expect(seen).toContain("/markets/slug/btc-95k"); // fails before: /markets/slug/btc-nov (404, refused)
    expect(seen).not.toContain("/markets/slug/btc-nov");
  });

  test("/event/<event> with several open markets answers with the list, reads no market", async () => {
    const seen = stub();
    const err = (await build("https://polymarket.com/event/btc-nov").catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("btc-95k");
    expect(err.message).toContain("btc-90k");
    expect(err.message).not.toContain("btc-60k");
    expect(seen.filter((p) => p.startsWith("/markets/"))).toEqual([]);
  });
});

describe("R1-M5: relayed decisions / refund redirects have no limit", () => {
  test("one signer cannot make the relayer send 50 transactions in a burst", async () => {
    const { deps, sent } = stubDeps();
    const caller = appRouter.createCaller({ deps, limiter: new RateLimiter(), ip: "203.0.113.7", country: "DE" });
    for (let i = 0; i < 25; i++) {
      await caller.decide({ id: "9", signer: SENDER, action: 1, deadline: "9999999999", signature: "0x01" }).catch(() => {});
      await caller.redirectRefund({ id: "9", refundTo: SENDER, altRefundTo: ZERO, deadline: "9999999999", signature: "0x01" }).catch(() => {});
    }
    expect(sent.length).toBeLessThanOrEqual(10); // fails: 50 relayer-paid sends (each a valid no-op on chain, see test_R1_M5)
  });
});

describe("R1-M8: keeper refund sweep is head-of-line blocked by stuck escrows", () => {
  test("50 un-refundable expired escrows (frozen refund addresses) must not stop the sweep for an honest one", async () => {
    const { deps, sent } = stubDeps();
    const now = Date.now();
    // 50 attacker escrows (1 USDG each) whose refund destinations are frozen, expired first; then an honest one
    const rows = [
      ...Array.from({ length: 50 }, (_, i) => ({ id: String(1000 + i), alt: ZERO, expiry: new Date(now - 10 * 86400_000 + i), status: Status.OPEN })),
      { id: "7", alt: ZERO, expiry: new Date(now - 3600_000), status: Status.OPEN },
    ];
    let call = 0;
    (deps.db as any).select = () => {
      const q: any = {
        _limit: Infinity,
        _ordered: false,
        from: () => q,
        where: () => q,
        orderBy: () => ((q._ordered = true), q),
        limit: (n: number) => {
          q._limit = n;
          return q;
        },
        then: (res: (v: unknown[]) => unknown) => {
          call++;
          // only the expired-refund query (call 4: after TIME, PRICE, OUTCOME passes) returns rows
          const out = call === 4 ? [...rows].sort((a, b) => a.expiry.getTime() - b.expiry.getTime()).slice(0, q._limit) : [];
          return res(out);
        },
      };
      return q;
    };
    // the 50 attacker refunds always fail simulation (USDG refuses frozen recipients); the honest one would succeed
    (deps.clients.publicClient as any).simulateContract = async (req: { functionName: string; args: unknown[] }) => {
      if (req.functionName === "refund" && (req.args[0] as bigint) >= 1000n) throw new Error("Blocked()");
      return { request: req };
    };
    (deps as any).alert = async () => true;
    await keeperTick(deps);
    expect(sent.some((s) => s.functionName === "refund" && s.args[0] === 7n)).toBe(true); // fails: never reached
  });
});
