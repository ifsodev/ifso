import { describe, expect, test } from "bun:test";
import { ALERT_CLAIM_PREFIX, ALERT_DEDUPE_MS, LOG_ONLY_CAUSES, alertFromEnv, makeAlert, redisClaim, type ClaimStore } from "../src/ops/alerts";
import { loadEnv } from "../src/config/env";
import { indexerBehind, keeperLagged, lowBalance } from "../src/ops/monitors";

function setup(armed: boolean) {
  let t = 1_000_000;
  const sent: { url: string; body: { chat_id: string; text: string } }[] = [];
  const logs: string[] = [];
  const extras: Record<string, unknown>[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => (sent.push({ url, body: JSON.parse(init.body) }), { ok: true, status: 200 })) as never;
  const alert = makeAlert({ armed, token: "TOKEN", chatId: "-100", log: (m, x) => (logs.push(m), extras.push(x ?? {})), fetchImpl, now: () => t });
  return { alert, sent, logs, extras, advance: (ms: number) => (t += ms) };
}

describe("alerts (R6)", () => {
  test("one message per cause per 30 minutes", async () => {
    const { alert, sent, advance } = setup(true);
    expect(await alert("keeper-lag", "a")).toBe(true);
    expect(await alert("keeper-lag", "b")).toBe(false);
    expect(await alert("low-balance", "c")).toBe(true); // other cause is independent
    advance(ALERT_DEDUPE_MS - 1);
    expect(await alert("keeper-lag", "d")).toBe(false);
    advance(2);
    expect(await alert("keeper-lag", "e")).toBe(true);
    expect(sent.length).toBe(3);
    expect(sent[0]!.body.chat_id).toBe("-100");
    expect(sent[0]!.url).toContain("/sendMessage");
  });
  test("self-healing causes (rpc-failover, indexer-reorg) are raised and logged, never sent, even when armed", async () => {
    const { alert, sent, logs, extras } = setup(true);
    expect([...LOG_ONLY_CAUSES].sort()).toEqual(["indexer-reorg", "rpc-failover"]);
    for (const cause of ["rpc-failover", "indexer-reorg"]) {
      expect(await alert(cause, "primary RPC failing")).toBe(true); // handled: the log is the configured sink
      expect(await alert(cause, "again")).toBe(true); //              every occurrence is logged; nothing to dedupe
    }
    expect(sent.length).toBe(0);
    expect(logs.filter((l) => l.includes("log-only")).length).toBe(4);
    expect(extras[0]).toMatchObject({ cause: "rpc-failover", length: "primary RPC failing".length });
    expect(await alert("keeper-lag", "x")).toBe(true); // a cause someone must act on is still sent
    expect(sent.length).toBe(1);
  });
  test("unarmed: logs only, never calls the network (and counts as handled, audit I-10)", async () => {
    const { alert, sent, logs } = setup(false);
    expect(await alert("keeper-lag", "x")).toBe(true);
    expect(sent.length).toBe(0);
    expect(logs.some((l) => l.includes("unarmed"))).toBe(true);
  });
  test("a failing send never throws or leaks the token", async () => {
    const logs: string[] = [];
    const alert = makeAlert({ armed: true, token: "TOKEN", chatId: "1", log: (m, x) => logs.push(m + JSON.stringify(x ?? {})), fetchImpl: (async () => { throw new Error("boom TOKEN"); }) as never });
    expect(await alert("c", "t")).toBe(false);
    expect(logs.join("")).not.toContain("TOKEN");
  });
});

/** In-memory stand-in for Redis `SET key value PX ttl NX`, with a test clock. One instance = one shared Redis. */
function fakeRedis(clock: () => number) {
  const keys = new Map<string, number>(); // key -> expiry
  const calls: string[] = [];
  const store: ClaimStore = {
    async set(key, _v, px, ttl, nx) {
      calls.push(`${key} ${px} ${ttl} ${nx}`);
      const exp = keys.get(key);
      if (exp !== undefined && exp > clock()) return null;
      keys.set(key, clock() + ttl);
      return "OK";
    },
  };
  return { store, calls };
}

describe("shared alert dedupe across processes", () => {
  const env = loadEnv({ ESCROW_ADDRESS: "0x00000000000000000000000000000000000e5c20", ALERTS_ARMED: "1", OPS_BOT_TOKEN: "TOKEN", OPS_CHAT_ID: "-100" });
  function twoProcesses(store?: ClaimStore) {
    let t = 5_000_000;
    const sent: string[] = [];
    const logs: string[] = [];
    const fetchImpl = (async (_u: string, init: { body: string }) => (sent.push(JSON.parse(init.body).text), { ok: true, status: 200 })) as never;
    const mk = () => alertFromEnv(env, (m) => logs.push(m), { fetchImpl, now: () => t }, store);
    return { api: mk(), worker: mk(), sent, logs, advance: (ms: number) => (t += ms), now: () => t };
  }

  test("api and worker sharing one Redis claim send a cause once per 30 minutes between them", async () => {
    let clock = 0;
    const redis = fakeRedis(() => clock);
    const { api, worker, sent } = twoProcesses(redis.store);
    expect(await api("keeper-lag", "from api")).toBe(true);
    expect(await worker("keeper-lag", "from worker")).toBe(false); // claimed by the api process
    expect(sent).toEqual(["[ifso ops] keeper-lag: from api"]);
    expect(redis.calls[0]).toBe(`${ALERT_CLAIM_PREFIX}keeper-lag PX ${ALERT_DEDUPE_MS} NX`);
    expect(await worker("low-balance", "w")).toBe(true); // a different cause is its own claim
    clock += ALERT_DEDUPE_MS + 1; //                       the key expired in Redis
    expect(await worker("keeper-lag", "again")).toBe(true);
    expect(sent.length).toBe(3);
  });

  test("without a store (tests, the bot role) each process dedupes in its own memory", async () => {
    const { api, worker, sent } = twoProcesses();
    expect(await api("keeper-lag", "a")).toBe(true);
    expect(await worker("keeper-lag", "b")).toBe(true);
    expect(sent.length).toBe(2);
  });

  test("a failing Redis never swallows an alert: it falls back to memory dedupe", async () => {
    const broken: ClaimStore = { set: async () => { throw new Error("ECONNREFUSED"); } };
    const { api, sent, logs } = twoProcesses(broken);
    expect(await api("keeper-lag", "a")).toBe(true);
    expect(await api("keeper-lag", "b")).toBe(false); // memory still dedupes within the process
    expect(sent.length).toBe(1);
    expect(logs.some((l) => l.includes("claim failed"))).toBe(true);
  });

  test("a hung Redis falls back after the claim timeout", async () => {
    const hung: ClaimStore = { set: () => new Promise(() => {}) };
    const { api, sent } = twoProcesses(hung);
    expect(await api("keeper-lag", "a")).toBe(true);
    expect(sent.length).toBe(1);
  });

  test("redisClaim maps SET NX to a boolean", async () => {
    const r = fakeRedis(() => 0);
    const claim = redisClaim(r.store);
    expect(await claim("x", 1000)).toBe(true);
    expect(await claim("x", 1000)).toBe(false);
  });
});

describe("alert thresholds", () => {
  test("keeper lag > 10 min", () => {
    const now = new Date("2026-01-01T00:20:00Z");
    expect(keeperLagged(new Date("2026-01-01T00:09:59Z"), now)).toBe(true);
    expect(keeperLagged(new Date("2026-01-01T00:10:01Z"), now)).toBe(false);
  });
  test("indexer behind > 500 blocks", () => {
    expect(indexerBehind(1500n, 1000n)).toBe(false);
    expect(indexerBehind(1501n, 1000n)).toBe(true);
  });
  test("low balance", () => {
    expect(lowBalance(1_000_000_000_000_000n, 0.002)).toBe(true);
    expect(lowBalance(3_000_000_000_000_000n, 0.002)).toBe(false);
  });
});
