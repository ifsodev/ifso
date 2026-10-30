// R5: one message per event per watcher, paced per chat; plus the Postgres lookup of who is watching.
import { describe, expect, test } from "bun:test";
import { ChatPacer, createNotifier, type NotifyEvent, type NotifyStore, type Target } from "../src/workers/notifier";

const T = (chatId: number, role: Target["role"], escrowId = "1"): Target => ({ chatId: BigInt(chatId), role, escrowId, amount: "20000000" });
const storeOf = (targets: Target[]): NotifyStore => ({ targets: async () => targets });

function harness(targets: Target[], pacer?: ChatPacer, maxWaitMs?: number) {
  const sent: { chat: bigint; text: string }[] = [];
  const logs: string[] = [];
  const slept: number[] = [];
  let clock = 1_000_000;
  const p = pacer ?? new ChatPacer(1100, 18, () => clock);
  const notify = createNotifier({
    store: storeOf(targets),
    send: async (chat, text) => void sent.push({ chat, text }),
    log: (m) => void logs.push(m),
    pacer: p,
    sleep: async (ms) => void (slept.push(ms), (clock += ms)),
    maxWaitMs,
  });
  return { notify, sent, logs, slept, tick: (ms: number) => (clock += ms) };
}

const ev = (name: string, extra: Partial<NotifyEvent> = {}): NotifyEvent => ({ name, escrowId: "1", args: { amount: "20000000", to: "0x00000000000000000000000000000000000000aa", outcome: 1 }, txHash: `0x${name}`, ...extra });

describe("notifier (R5)", () => {
  test("every lifecycle event messages each watcher exactly once", async () => {
    const names = ["Created", "Claimed", "Accepted", "Met", "Released", "Returned", "Voided", "Proposed", "Disputed"];
    for (const name of names) {
      const h = harness([T(1, "sender"), T(2, "recipient"), T(3, "referee")]);
      expect(await h.notify(ev(name))).toBe(3);
      expect(h.sent.map((s) => Number(s.chat)).sort()).toEqual([1, 2, 3]);
      expect(h.sent.every((s) => s.text.length > 10)).toBe(true);
    }
  });

  test("a chat that holds two roles still gets one message", async () => {
    const h = harness([T(1, "sender"), T(1, "referee"), T(2, "recipient")]);
    expect(await h.notify(ev("Met"))).toBe(2);
    expect(h.sent.filter((s) => s.chat === 1n).length).toBe(1);
  });

  test("roles read differently on creation, and no message ever carries a link", async () => {
    const h = harness([T(1, "sender"), T(2, "recipient"), T(3, "referee")]);
    await h.notify(ev("Created"));
    const by = Object.fromEntries(h.sent.map((s) => [Number(s.chat), s.text]));
    expect(by[1]).toContain("locked in your if-so payment");
    expect(by[2]).toContain("waiting for you");
    expect(by[3]).toContain("named referee");
    expect(h.sent.every((s) => !/https?:|#/.test(s.text))).toBe(true);
    expect(by[1]).toContain("20 USDG");
  });

  test("a replayed log (same transaction) does not message twice", async () => {
    const h = harness([T(1, "sender")]);
    await h.notify(ev("Met"));
    await h.notify(ev("Met"));
    expect(h.sent.length).toBe(1);
    await h.notify(ev("Released")); // a different event still goes out
    expect(h.sent.length).toBe(2);
  });

  test("events the notifier does not message about are ignored", async () => {
    const h = harness([T(1, "sender")]);
    expect(await h.notify(ev("RefundAddressesChanged"))).toBe(0);
    expect(await h.notify({ name: "Met", args: {} })).toBe(0); // no escrow id
    expect(h.sent.length).toBe(0);
  });

  test("results posted by the resolver name the question", async () => {
    const h = harness([{ ...T(1, "sender"), questionTitle: "Arsenal v Chelsea" }]);
    await h.notify({ name: "Proposed", questionId: "0xq", args: { outcome: 1 }, txHash: "0xp" });
    expect(h.sent[0]!.text).toContain("Arsenal v Chelsea");
    expect(h.sent[0]!.text).toContain("challenge it for the next 2 hours");
  });

  test("per-chat pacing: a burst to one chat goes out at least 1.1 s apart, each chat paced on its own", async () => {
    let clock = 1_000_000;
    const at: { chat: bigint; t: number }[] = [];
    const notify = createNotifier({
      store: storeOf([T(1, "sender"), T(2, "sender")]),
      send: async (chat) => void at.push({ chat, t: clock }),
      log: () => {},
      pacer: new ChatPacer(1100, 18, () => clock),
      sleep: async (ms) => void (clock += ms),
    });
    for (let i = 0; i < 5; i++) await notify(ev("Met", { txHash: `0x${i}` }));
    expect(at.length).toBe(10);
    for (const chat of [1n, 2n]) {
      const ts = at.filter((x) => x.chat === chat).map((x) => x.t);
      for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBeGreaterThanOrEqual(1100);
    }
  });

  test("per-minute cap: 18 go out, the rest are dropped rather than queued, and the chat recovers after a minute", async () => {
    let clock = 5_000_000;
    const pacer = new ChatPacer(1100, 18, () => clock);
    const h = harness([T(1, "sender")], pacer, 20_000);
    for (let i = 0; i < 40; i++) {
      await h.notify(ev("Met", { txHash: `0x${i}` }));
      clock += 1200; // events arrive just over a second apart
    }
    expect(h.sent.length).toBe(18);
    expect(h.logs.some((l) => l.includes("rate limit"))).toBe(true);
    clock += 61_000;
    await h.notify(ev("Met", { txHash: "0xlater" }));
    expect(h.sent.length).toBe(19);
  });

  test("pacer: 18 a minute and 1.1 s apart, exactly", () => {
    let t = 0;
    const p = new ChatPacer(1100, 18, () => t);
    const waits = Array.from({ length: 20 }, () => p.reserve(9n));
    expect(waits[0]).toBe(0);
    expect(waits[1]).toBe(1100);
    expect(waits[17]).toBe(17 * 1100); // the 18th goes out 18.7 s in
    expect(waits[18]).toBeGreaterThanOrEqual(60_000); // the 19th waits for the minute window to clear
    expect(new ChatPacer(1100, 18, () => t).reserve(1n)).toBe(0); // new pacer, new chat
  });

  test("a failed send is logged without the message text and does not stop the others", async () => {
    const logs: Record<string, unknown>[] = [];
    const sent: bigint[] = [];
    const notify = createNotifier({
      store: storeOf([T(1, "sender"), T(2, "sender")]),
      send: async (chat) => {
        if (chat === 1n) throw new Error("Forbidden: bot was blocked by the user");
        sent.push(chat);
      },
      log: (_m, extra) => void logs.push(extra ?? {}),
      pacer: new ChatPacer(0, 1000),
    });
    expect(await notify(ev("Met"))).toBe(1);
    expect(sent).toEqual([2n]);
    expect(JSON.stringify(logs)).not.toContain("It happened");
  });
});
