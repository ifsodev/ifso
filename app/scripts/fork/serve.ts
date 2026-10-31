// Fork stack step 3: the real API (createApp) and the real workers (indexer, keeper, price watcher, resolver) in ONE
// process, against the local anvil fork. Differences from `bun run all`, all fork-only and all in this file:
//  - Redis is not needed: the rate limiter runs in memory and the workers run on timers instead of BullMQ queues
//  - Date is shifted by an offset the run sets through the admin port (POST /offset), so the server's clock follows
//    evm_increaseTime. The API builds deadlines from Date.now(); without this, a warped chain and the API disagree.
//  - provider reads (league listings, football and market results) come from the recorded fixtures in test/fixtures
//  - a dev signer on the wallet port holds the test keys for the browser pass (127.0.0.1 only, fork keys only)
// Ports: API=$API_PORT, admin=API_PORT+1, dev signer=API_PORT+2.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---- shifted clock (before anything reads the time)
const RealDate = Date;
let offsetMs = 0;
class ForkDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(RealDate.now() + offsetMs);
    else super(...(a as [number]));
  }
  static now() {
    return RealDate.now() + offsetMs;
  }
}
(globalThis as { Date: DateConstructor }).Date = ForkDate as unknown as DateConstructor;

const FORK_DIR = process.env.FORK_DIR ?? join(import.meta.dir, "../../.fork");
const fileEnv = JSON.parse(readFileSync(join(FORK_DIR, "env.json"), "utf8")) as Record<string, string>;
const actors = JSON.parse(readFileSync(join(FORK_DIR, "actors.json"), "utf8"));
Object.assign(process.env, fileEnv);

const { loadEnv } = await import("../../src/config/env");
const { makeClients } = await import("../../src/chain");
const { createDb } = await import("../../src/db/client");
const { createApp } = await import("../../src/api/app");
const { RateLimiter } = await import("../../src/api/rateLimit");
const { defaultProbes } = await import("../../src/ops/health");
const { consoleLog } = await import("../../src/workers/deps");
const { keeperTick } = await import("../../src/workers/keeper");
const { priceWatchTick } = await import("../../src/workers/priceWatcher");
const { resolverTick } = await import("../../src/workers/resolver");
const { indexerTick } = await import("../../src/workers/indexer");
const { fixtureSources, eplEvents, oddsScores, pmMarkets } = await import("../../test/helpers/resolverFixtures");
const { privateKeyToAccount } = await import("viem/accounts");

const env = loadEnv(process.env) // no role: Redis is not used on the fork;
const log = consoleLog("fork");
const clients = makeClients(env);
const { db } = createDb(env.DATABASE_URL);
const alerts: Array<{ at: string; cause: string; text: string }> = [];
const deps = { env, db, clients, log, alert: async (cause: string, text: string) => (alerts.push({ at: new Date().toISOString(), cause, text }), log("ALERT " + cause, { text }), true) } as import("../../src/workers/deps").Deps;

// ---- recorded provider data. Fixture i is "<home> vs <away>" with a recorded final score; kickoff is set relative to now
// by the listing below, so a question built through the API opens, closes and resolves on the fork clock.
const base = fixtureSources();
const marketEnd = Date.now() + 3 * 3600_000; // fixed once: the open market ends 3 hours after the stack starts
const marketSlug = pmMarkets[0]!.gamma.slug;
deps.sources = {
  ...base,
  async gamma(slug) {
    const r = await base.gamma(slug);
    if (!r.market) return r;
    // an open, liquid market ending in 3 hours (fork clock); the recorded payout (ctf) says how it settled
    if (Date.now() >= marketEnd) return r; // after its end the recorded, resolved market is what the sources show
    const m = { ...r.market, endDate: new Date(marketEnd).toISOString(), closed: false, active: true, liquidity: "50000", volume: "250000", liquidityNum: 50000, volumeNum: 250000, outcomePrices: '["0.55","0.45"]' } as typeof r.market;
    return { report: r.report, market: m };
  },
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("api.the-odds-api.com") && url.includes("/events")) {
    // arsenal v wolves (recorded final 2-0 home win) kicks off 40 minutes from now; man utd v fulham 50; ipswich v liverpool 60; everton v brighton 70
    const pick = [2, 0, 1, 3];
    return json(pick.map((i, n) => {
      const o = oddsScores.find((s) => s._derivedFrom === eplEvents[i]!.idEvent)!;
      return { id: o.id, sport_key: "soccer_epl", sport_title: "EPL", commence_time: new Date(Date.now() + (40 + n * 10) * 60_000).toISOString(), home_team: eplEvents[i]!.strHomeTeam, away_team: eplEvents[i]!.strAwayTeam };
    }));
  }
  if (url.includes("thesportsdb.com") && url.includes("searchevents")) {
    const e = decodeURIComponent(url).match(/e=([^&]+)&d=(\d{4}-\d{2}-\d{2})/);
    const ev = eplEvents.find((x) => `${x.strHomeTeam}_vs_${x.strAwayTeam}`.replace(/\s+/g, "_") === e?.[1]);
    return json({ event: ev ? [{ idEvent: ev.idEvent, dateEvent: e![2] }] : null });
  }
  return realFetch(input as never, init);
}) as typeof fetch;

// ---- API
const limiter = new RateLimiter();
const app = createApp(deps, limiter, undefined, defaultProbes(deps));
Bun.serve({ port: env.PORT, hostname: "127.0.0.1", fetch: (req, server) => app.fetch(req, { socketIp: server.requestIP(req)?.address }) });
log(`api listening on 127.0.0.1:${env.PORT}`);

// ---- workers on timers (one pass at a time each, like a BullMQ tick)
const paused = new Set<string>(); // admin port: POST /worker {name, on}
const every = (name: string, ms: number, fn: () => Promise<void>) => {
  let busy = false;
  setInterval(async () => {
    if (busy || paused.has(name)) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      log(`${name} tick failed`, { error: String((e as Error)?.message ?? e).slice(0, 300) });
    } finally {
      busy = false;
    }
  }, ms);
};
every("indexer", 1_500, () => indexerTick(deps, async () => {}));
every("keeper", 2_000, () => keeperTick(deps));
every("priceWatch", 2_500, () => priceWatchTick(deps));
every("resolver", 3_000, () => resolverTick(deps));
log("workers started");

// ---- admin port: clock offset, alerts
Bun.serve({
  port: env.PORT + 1,
  hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/offset") {
      if (req.method === "POST") offsetMs = Number(((await req.json()) as { ms: number }).ms);
      return Response.json({ ms: offsetMs });
    }
    if (u.pathname === "/worker" && req.method === "POST") {
      const b = (await req.json()) as { name: string; on: boolean };
      if (b.on) paused.delete(b.name);
      else paused.add(b.name);
      return Response.json({ paused: [...paused] });
    }
    if (u.pathname === "/alerts") return Response.json(alerts);
    if (u.pathname === "/sources") return Response.json({ marketSlug });
    return new Response("not found", { status: 404 });
  },
});

// ---- dev signer for the browser pass. Holds ONLY the fork's throwaway keys. CORS is open to the local site origin.
const accounts = new Map(Object.entries(actors.keys as Record<string, `0x${string}`>).map(([n, k]) => [privateKeyToAccount(k).address.toLowerCase(), { n, a: privateKeyToAccount(k) }]));
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST,GET,OPTIONS" };
Bun.serve({
  port: env.PORT + 2,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const u = new URL(req.url);
    if (u.pathname === "/accounts") return Response.json([...accounts.values()].map((x) => ({ name: x.n, address: x.a.address })), { headers: cors });
    if (u.pathname === "/sign" && req.method === "POST") {
      const b = (await req.json()) as { address: string; kind: "typed" | "message" | "send"; typedData?: any; message?: string; tx?: { to?: `0x${string}`; data?: `0x${string}`; value?: string; gas?: string } };
      const who = accounts.get(b.address.toLowerCase());
      if (!who) return Response.json({ error: "unknown account" }, { status: 404, headers: cors });
      if (b.kind === "send") {
        const { createWalletClient, http } = await import("viem");
        const w = createWalletClient({ account: who.a, chain: clients.chain, transport: http(env.RHC_RPC_URLS.split(",")[0]!) });
        const hash = await w.sendTransaction({ to: b.tx?.to, data: b.tx?.data, value: b.tx?.value ? BigInt(b.tx.value) : undefined, gas: b.tx?.gas ? BigInt(b.tx.gas) : undefined } as never);
        return Response.json({ hash }, { headers: cors });
      }
      const sig = b.kind === "typed" ? await who.a.signTypedData(b.typedData) : await who.a.signMessage({ message: b.message ?? "" });
      return Response.json({ signature: sig }, { headers: cors });
    }
    return new Response("not found", { status: 404, headers: cors });
  },
});
log("dev signer ready");
