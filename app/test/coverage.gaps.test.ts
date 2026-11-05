// Behaviour tests for code paths that had no direct test: gasless challenge accept, the provider fetchers (against a stubbed
// fetch / a local JSON-RPC server), the Pyth update fetch, the Redis rate-limit branch, worker alert plumbing, the copy rules and
// the fixture lookup. No network: fetch is replaced, the RPC server listens on 127.0.0.1 only.
import { afterEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { ClaimError, relayAccept } from "../src/api/claim";
import { listFixtureMatches, resetFixtureCache } from "../src/api/fixtures";
import { RateLimiter } from "../src/api/rateLimit";
import { findBannedWords } from "../src/client/copyRules";
import { loadEnv } from "../src/config/env";
import { linkKeyAddress, signAccept } from "../src/core/link";
import { fetchGamma, fetchCtf, POLYGON_CTF } from "../src/sources/polymarket";
import { fetchScore, listEvents } from "../src/sources/theOddsApi";
import { fetchEvent } from "../src/sources/theSportsDb";
import { consoleLog, raise, type Deps } from "../src/workers/deps";
import { fetchPythUpdate } from "../src/workers/pyth";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const stubFetch = (handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) => {
  const seen: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return seen;
};

const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const CH = ("0x" + "42".repeat(32)) as Hex;
const secret = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const acceptor = "0x0000000000000000000000000000000000000a11" as Address;

function acceptDeps(escrow: Record<string, unknown>, sendOk = true) {
  const sent: { functionName: string }[] = [];
  const e = { linkKey: linkKeyAddress(secret), flags: 1, conditionHash: CH, ...escrow };
  const deps = {
    env: loadEnv({ ESCROW_ADDRESS: ESCROW }),
    log: () => {},
    db: { insert: () => ({ values: async () => {} }) },
    clients: {
      chain: { id: 4663 },
      escrow: ESCROW,
      relayer: {
        account: { address: "0x00000000000000000000000000000000000000ee" },
        writeContract: async (req: { functionName: string }) => {
          if (!sendOk) throw new Error("boom");
          sent.push(req);
          return "0xdef" as Hex;
        },
      },
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
const acceptInput = (linkSig: Hex) => ({ id: 9n, acceptor, linkSig, counterRefundTo: acceptor, validAfter: 0n, validBefore: 9999999999n, authSig: ("0x" + "11".repeat(65)) as Hex });

describe("relayAccept", () => {
  test("a signed invite is relayed as acceptWithAuthorization", async () => {
    const { deps, sent } = acceptDeps({});
    const linkSig = await signAccept({ secret, chainId: 4663, escrow: ESCROW, id: 9n, acceptor, conditionHash: CH });
    expect(await relayAccept(deps, acceptInput(linkSig))).toEqual({ txHash: "0xdef" });
    expect(sent[0]?.functionName).toBe("acceptWithAuthorization");
  });

  test("an open challenge (no link key) needs no invite signature", async () => {
    const { deps, sent } = acceptDeps({ linkKey: ZERO });
    await relayAccept(deps, acceptInput(("0x" + "00".repeat(65)) as Hex));
    expect(sent.length).toBe(1);
  });

  test("a payment that is not a challenge is refused before any gas is spent", async () => {
    const { deps, sent } = acceptDeps({ flags: 0 });
    await expect(relayAccept(deps, acceptInput("0x00"))).rejects.toMatchObject({ code: "NOT_CLAIMABLE" });
    expect(sent.length).toBe(0);
  });

  test("an invite signature made for another acceptor is refused", async () => {
    const { deps, sent } = acceptDeps({});
    const other = await signAccept({ secret, chainId: 4663, escrow: ESCROW, id: 9n, acceptor: "0x0000000000000000000000000000000000000bad", conditionHash: CH });
    await expect(relayAccept(deps, acceptInput(other))).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    expect(sent.length).toBe(0);
  });

  test("a failed submission surfaces as TX_FAILED", async () => {
    const { deps } = acceptDeps({}, false);
    const linkSig = await signAccept({ secret, chainId: 4663, escrow: ESCROW, id: 9n, acceptor, conditionHash: CH });
    const err = await relayAccept(deps, acceptInput(linkSig)).catch((e) => e);
    expect(err).toBeInstanceOf(ClaimError);
    expect(err.code).toBe("TX_FAILED");
  });
});

describe("RateLimiter with Redis", () => {
  test("sets the window on the first hit and refuses above the limit", async () => {
    // audit I-17: one atomic EVAL (INCR, then EXPIRE when the key is new or has no TTL); this fake runs the same logic
    const counts = new Map<string, number>();
    const ttl = new Map<string, number>();
    const redis = {
      eval: async (_script: string, _n: number, k: string, s: number) => {
        const n = counts.set(k, (counts.get(k) ?? 0) + 1).get(k)!;
        if (n === 1 || !ttl.has(k)) ttl.set(k, s);
        return n;
      },
    };
    const rl = new RateLimiter(redis as never);
    expect(await rl.hit("a", 2, 60)).toBe(true);
    expect(await rl.hit("a", 2, 60)).toBe(true);
    expect(await rl.hit("a", 2, 60)).toBe(false);
    expect([...ttl]).toEqual([["rl:a", 60]]);
  });
});

describe("worker deps", () => {
  test("consoleLog prints one JSON line with bigint values as text", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => void lines.push(s);
    try {
      consoleLog("scope-x")("hello", { n: 5n });
    } finally {
      console.log = orig;
    }
    const j = JSON.parse(lines[0]!);
    expect(j).toMatchObject({ scope: "scope-x", msg: "hello", n: "5" });
  });

  test("raise uses the alert function, falls back to a log line, and never throws", async () => {
    const logs: string[] = [];
    const alerts: string[] = [];
    const base = { log: (m: string) => void logs.push(m) } as unknown as Deps;
    await raise({ ...base, alert: async (c: string) => (alerts.push(c), true) } as unknown as Deps, "cause-1", "text");
    expect(alerts).toEqual(["cause-1"]);
    await raise(base, "cause-2", "text");
    expect(logs).toEqual(["ALERT cause-2"]);
    await raise({ ...base, alert: async () => { throw new Error("telegram down"); } } as unknown as Deps, "cause-3", "text");
    expect(logs).toContain("alert failed");
  });
});

describe("copy rules", () => {
  test("finds every banned word, case-insensitively, and nothing in plain copy", () => {
    expect(findBannedWords("Pay a friend")).toEqual([]);
    expect(findBannedWords("A BET with good odds, safe yield").sort()).toEqual(["BET", "odds", "safe", "yield"].sort());
  });
});

describe("provider fetchers", () => {
  test("Polymarket Gamma: reads the market by slug and turns it into a report", async () => {
    const m = { slug: "s", question: "q", conditionId: CH, closed: true, umaResolutionStatus: "resolved", outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' };
    const seen = stubFetch(() => ({ body: m }));
    const r = await fetchGamma("a b");
    expect(seen[0]!.url).toContain("/markets/slug/a%20b");
    expect(r.report).toMatchObject({ provider: "polymarket-gamma", status: "final", outcome: 1 });
    stubFetch(() => ({ status: 404, body: { error: "slug not found" } }));
    expect((await fetchGamma("none")).report.status).toBe("pending");
    stubFetch(() => ({ status: 503, body: "down" }));
    expect(await fetchGamma("x").catch((e: Error) => e.message)).toContain("503");
  });

  test("a provider error status is thrown with the host only, never the key in the URL", async () => {
    stubFetch(() => ({ status: 503, body: "down" }));
    const err = await fetchScore("SECRET-KEY", "soccer_epl", "ev1").catch((e) => e as Error);
    const msg = String((err as Error).message);
    expect(msg).toContain("503");
    expect(msg).not.toContain("SECRET-KEY");
  });

  test("The Odds API: events list and score for one event", async () => {
    const seen = stubFetch((url) =>
      url.includes("/scores/")
        ? { body: [{ id: "ev1", sport_key: "soccer_epl", commence_time: "2026-01-01T00:00:00Z", completed: true, home_team: "A", away_team: "B", scores: [{ name: "A", score: "2" }, { name: "B", score: "1" }], last_update: null }] }
        : { body: [{ id: "ev1", sport_key: "soccer_epl", commence_time: "2026-01-01T00:00:00Z", home_team: "A", away_team: "B" }] },
    );
    expect((await listEvents("k", "soccer_epl")).body[0]!.id).toBe("ev1");
    expect(seen[0]!.url).toContain("/sports/soccer_epl/events?apiKey=k");
    const rep = await fetchScore("k", "soccer_epl", "ev1");
    expect(rep).toMatchObject({ provider: "theoddsapi", status: "final" });
  });

  test("TheSportsDB: finished match is final, a missing event is pending", async () => {
    stubFetch(() => ({ body: { events: [{ idEvent: "1", strStatus: "FT", intHomeScore: "0", intAwayScore: "3", strHomeTeam: "A", strAwayTeam: "B" }] } }));
    expect(await fetchEvent("123", "1")).toMatchObject({ provider: "thesportsdb", status: "final" });
    stubFetch(() => ({ body: { events: null } }));
    expect((await fetchEvent("123", "1")).status).toBe("pending");
  });

  test("Polygon CTF: reads the payouts over JSON-RPC and reports final / pending", async () => {
    const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
    const calls: string[] = [];
    let den = 1n;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const b = (await req.json()) as { id: number; method: string; params: [{ to: string; data: string }] };
        calls.push(b.method);
        const data = b.params?.[0]?.data ?? "";
        // payoutDenominator(bytes32) has 36 bytes of calldata, payoutNumerators(bytes32,uint256) has 68
        const idx = data.length > 74 ? BigInt("0x" + data.slice(-64)) : -1n;
        const result = idx === -1n ? word(den) : word(idx === 0n ? 1n : 0n);
        return Response.json({ jsonrpc: "2.0", id: b.id, result });
      },
    });
    try {
      const rpc = `http://127.0.0.1:${server.port}`;
      expect(POLYGON_CTF).toMatch(/^0x4D97/);
      expect(await fetchCtf(rpc, CH)).toMatchObject({ provider: "polygon-ctf", status: "final", outcome: 1 });
      den = 0n;
      expect((await fetchCtf(rpc, CH)).status).toBe("pending");
    } finally {
      server.stop(true);
    }
  });
});

describe("Pyth update fetch", () => {
  const priceId = ("0x" + "ab".repeat(32)) as Hex;
  const depsWith = (apiKey?: string) =>
    ({ env: { PYTH_HERMES_URL: "https://hermes.test", PYTH_API_KEY: apiKey }, clients: { publicClient: { readContract: async () => 7n } } }) as unknown as Deps;

  test("returns the update data and the fee, sending the API key when set", async () => {
    const seen = stubFetch(() => ({ body: { binary: { data: ["aa", "0xbb"] } } }));
    expect(await fetchPythUpdate(depsWith("k1"), priceId, 1234)).toEqual({ data: ["0xaa", "0xbb"], fee: 7n });
    expect(seen[0]!.url).toBe(`https://hermes.test/v2/updates/price/1234?ids[]=${priceId}&encoding=hex`);
    expect((seen[0]!.init!.headers as Record<string, string>)["x-api-key"]).toBe("k1");
    await fetchPythUpdate(depsWith(), priceId, 1);
    expect((seen[1]!.init!.headers as Record<string, string>)["x-api-key"]).toBeUndefined();
  });

  test("a failed request or an empty answer is undefined", async () => {
    stubFetch(() => ({ status: 500, body: "x" }));
    expect(await fetchPythUpdate(depsWith(), priceId, 1)).toBeUndefined();
    stubFetch(() => ({ body: {} }));
    expect(await fetchPythUpdate(depsWith(), priceId, 1)).toBeUndefined();
  });
});

describe("fixture lookup", () => {
  test("lists upcoming league fixtures for a typed team, or undefined without an odds key", async () => {
    resetFixtureCache(); // another file may have filled the 10-minute events cache with its own fixtures (public CI, 2026-11-01)
    const soon = new Date(Date.now() + 2 * 86400_000).toISOString();
    stubFetch((url) => ({ body: url.includes("soccer_epl") ? [{ id: "e1", sport_key: "soccer_epl", commence_time: soon, home_team: "Arsenal FC", away_team: "Chelsea FC" }] : [] }));
    const withKey = { env: { ODDS_API_KEY: "k" } } as unknown as Deps;
    const hits = await listFixtureMatches(withKey, "arsenal");
    expect(hits).toEqual([{ home: "Arsenal FC", away: "Chelsea FC", league: "Premier League", commence: Math.floor(Date.parse(soon) / 1000), matched: "Arsenal FC" }]);
    expect(await listFixtureMatches({ env: {} } as unknown as Deps, "arsenal")).toBeUndefined();
  });
});
