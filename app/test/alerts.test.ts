import { describe, expect, test } from "bun:test";
import { ALERT_DEDUPE_MS, makeAlert } from "../src/ops/alerts";
import { indexerBehind, keeperLagged, lowBalance } from "../src/ops/monitors";

function setup(armed: boolean) {
  let t = 1_000_000;
  const sent: { url: string; body: { chat_id: string; text: string } }[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => (sent.push({ url, body: JSON.parse(init.body) }), { ok: true, status: 200 })) as never;
  const alert = makeAlert({ armed, token: "TOKEN", chatId: "-100", log: (m) => logs.push(m), fetchImpl, now: () => t });
  return { alert, sent, logs, advance: (ms: number) => (t += ms) };
}

describe("alerts (R6)", () => {
  test("one message per cause per 30 minutes", async () => {
    const { alert, sent, advance } = setup(true);
    expect(await alert("keeper-lag", "a")).toBe(true);
    expect(await alert("keeper-lag", "b")).toBe(false);
    expect(await alert("rpc-failover", "c")).toBe(true); // other cause is independent
    advance(ALERT_DEDUPE_MS - 1);
    expect(await alert("keeper-lag", "d")).toBe(false);
    advance(2);
    expect(await alert("keeper-lag", "e")).toBe(true);
    expect(sent.length).toBe(3);
    expect(sent[0]!.body.chat_id).toBe("-100");
    expect(sent[0]!.url).toContain("/sendMessage");
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
