// A pasted polymarket.com link used to become the FIRST path segment after /event/ (router build): for
// /event/<event>/<market> that is the event slug, which is not a market (Gamma /markets/slug answers 404), so the
// payment was refused at build. Now: /event/<event>/<market> -> the market slug; /event/<event> -> the event is looked
// up on Gamma (/events?slug=): one open market -> its slug, several -> a short list to pick from (never a guess),
// none -> a plain "no open market" answer. Stubs copy the live Gamma shapes (trimmed), read 2026-11-05.
import { afterEach, describe, expect, test } from "bun:test";
import type { BotStore } from "../src/bot/store";
import { handleCommand } from "../src/bot/flow";
import { copy } from "../src/core/copy";
import { parsePolymarketLink, resolvePolymarketRef, type GammaEvent } from "../src/sources/polymarket";

const mk = (slug: string, title: string, closed = false, active = true) => ({
  slug,
  question: `Will ${title} happen?`,
  groupItemTitle: title,
  conditionId: `0x${"11".repeat(32)}` as const,
  closed,
  active,
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.5","0.5"]',
  endDate: "2026-12-31T00:00:00Z",
});

// live: pete-hegseth-out-as-secretary-of-defense-by-december-31 has one market with the same slug and groupItemTitle ""
const ONE: GammaEvent = { slug: "pete-hegseth-out-as-secretary-of-defense-by-december-31", title: "Pete Hegseth out as Secretary of Defense by December 31?", closed: false, markets: [{ ...mk("pete-hegseth-out-as-secretary-of-defense-by-december-31", ""), question: "Pete Hegseth out as Secretary of Defense by December 31?" }] };
// live: a 7-market event, some markets closed (resolved dates), the rest open
const MANY: GammaEvent = {
  slug: "what-price-will-bitcoin-hit-in-november-2026",
  title: "What price will Bitcoin hit in November?",
  closed: false,
  markets: [
    mk("will-bitcoin-reach-100k-in-november-2026", "↑ 100,000"),
    mk("will-bitcoin-reach-97pt5k-in-november-2026", "↑ 97,500"),
    mk("will-bitcoin-dip-to-60k-in-november-2026", "↓ 60,000", true),
    mk("will-bitcoin-reach-95k-in-november-2026", "↑ 95,000"),
    mk("will-bitcoin-reach-92k-in-november-2026", "↑ 92,000"),
    mk("will-bitcoin-reach-90k-in-november-2026", "↑ 90,000"),
    mk("will-bitcoin-reach-88k-in-november-2026", "↑ 88,000"),
  ],
};
// live: fed-decision-in-december is closed, all 4 markets closed (the Dec-2025 meeting)
const CLOSED: GammaEvent = { slug: "fed-decision-in-december", title: "Fed decision in December?", closed: true, markets: [mk("fed-decreases-interest-rates-by-25-bps-after-december-2025-meeting", "25 bps decrease", true), mk("no-change-in-fed-interest-rates-after-december-2025-meeting", "No change", true)] };
// several markets but only one still open
const ONE_OPEN: GammaEvent = { slug: "ceasefire-continues-through", title: "Ceasefire continues through...?", closed: false, markets: [mk("ceasefire-through-november-1", "November 1", true), mk("ceasefire-through-november-30", "November 30")] };

const EVENTS = new Map([ONE, MANY, CLOSED, ONE_OPEN].map((e) => [e.slug, e]));
const seen: string[] = [];
const realFetch = globalThis.fetch;
function stubGamma() {
  seen.length = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    seen.push(u.pathname + u.search);
    if (u.pathname === "/events") {
      const e = EVENTS.get(u.searchParams.get("slug") ?? "");
      return new Response(JSON.stringify(e ? [e] : []), { status: 200 }); // live: unknown slug -> 200 []
    }
    return new Response(JSON.stringify({ error: "not stubbed" }), { status: 404 });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("parsePolymarketLink", () => {
  test("/event/<event>/<market> is the market (last segment), query and hash dropped", () => {
    expect(parsePolymarketLink("https://polymarket.com/event/what-price-will-bitcoin-hit-in-november-2026/will-bitcoin-reach-95k-in-november-2026?tid=1#x")).toEqual({ market: "will-bitcoin-reach-95k-in-november-2026" });
    expect(parsePolymarketLink("https://www.polymarket.com/event/e/m/")).toEqual({ market: "m" });
  });
  test("/event/<event> alone is an event; /market/<m> is a market; a plain slug is a market", () => {
    expect(parsePolymarketLink("https://polymarket.com/event/fed-decision-in-december")).toEqual({ event: "fed-decision-in-december" });
    expect(parsePolymarketLink("https://polymarket.com/market/some-market")).toEqual({ market: "some-market" });
    expect(parsePolymarketLink("some-open-market")).toEqual({ market: "some-open-market" });
  });
  test("rescore Info: a malformed percent-escape is an invalid link, not a thrown URIError", () => {
    for (const bad of ["https://polymarket.com/event/%E0%A4%A", "https://polymarket.com/event/e/%", "https://polymarket.com/market/%zz"]) expect(parsePolymarketLink(bad)).toEqual({ invalid: true });
  });
});

describe("resolvePolymarketRef with stubbed Gamma", () => {
  test("/event/<e>/<m>: the market slug, no event lookup", async () => {
    stubGamma();
    expect(await resolvePolymarketRef("https://polymarket.com/event/what-price-will-bitcoin-hit-in-november-2026/will-bitcoin-reach-95k-in-november-2026")).toEqual({ ok: true, slug: "will-bitcoin-reach-95k-in-november-2026" });
    expect(seen).toEqual([]);
  });

  test("an event with one market: that market's slug", async () => {
    stubGamma();
    expect(await resolvePolymarketRef(`https://polymarket.com/event/${ONE.slug}`)).toEqual({ ok: true, slug: ONE.slug });
    expect(seen).toEqual([`/events?slug=${ONE.slug}`]);
  });

  test("an event with one OPEN market among closed ones: the open one", async () => {
    stubGamma();
    expect(await resolvePolymarketRef(`https://polymarket.com/event/${ONE_OPEN.slug}`)).toEqual({ ok: true, slug: "ceasefire-through-november-30" });
  });

  test("an event with several open markets: a short list to pick from, never a guess", async () => {
    stubGamma();
    const r = await resolvePolymarketRef(`https://polymarket.com/event/${MANY.slug}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const lines = [
      copy.parse.marketPickLine("↑ 100,000", "will-bitcoin-reach-100k-in-november-2026"),
      copy.parse.marketPickLine("↑ 97,500", "will-bitcoin-reach-97pt5k-in-november-2026"),
      copy.parse.marketPickLine("↑ 95,000", "will-bitcoin-reach-95k-in-november-2026"),
      copy.parse.marketPickLine("↑ 92,000", "will-bitcoin-reach-92k-in-november-2026"),
      copy.parse.marketPickLine("↑ 90,000", "will-bitcoin-reach-90k-in-november-2026"),
    ].join("\n");
    expect(r.message).toBe(copy.parse.marketPick(MANY.title!, lines, 1));
    expect(r.message).not.toContain("60,000"); // the closed one is not offered
    expect(r.message).toContain("1 more");
  });

  test("an event with no open market: a plain answer", async () => {
    stubGamma();
    expect(await resolvePolymarketRef("https://polymarket.com/event/fed-decision-in-december")).toEqual({ ok: false, message: copy.parse.marketNoneOpen(CLOSED.title!) });
  });

  test("rescore Info: a malformed link is the plain 'not a Polymarket market link' answer, no Gamma call", async () => {
    stubGamma();
    expect(await resolvePolymarketRef("https://polymarket.com/event/%E0%A4%A")).toEqual({ ok: false, message: copy.parse.notPolymarketLink });
    expect(seen).toEqual([]);
  });

  test("not an event on Gamma: the slug is tried as a market (single-market pages share the slug)", async () => {
    stubGamma();
    expect(await resolvePolymarketRef("https://polymarket.com/event/unknown-thing")).toEqual({ ok: true, slug: "unknown-thing" });
  });
});

describe("the bot answers a multi-market or closed event link before any preview", () => {
  const store = { getUser: async () => undefined, upsertUser: async () => undefined, createIntent: async () => ({ id: "i1" }), updateIntent: async () => undefined } as unknown as BotStore;
  const env = { store, publicAppUrl: "https://example.test", tickers: new Set(["ETH"]), now: () => Date.UTC(2026, 10, 5, 12), polymarket: resolvePolymarketRef };

  test("several open markets: the pick list, no Review button", async () => {
    stubGamma();
    const r = await handleCommand(env, { tgId: 1n, chatId: 1n, cmd: "ifso", body: `@jake 20 if https://polymarket.com/event/${MANY.slug} resolves yes` });
    expect(r.text).toContain("↑ 95,000");
    expect(r.buttons).toBeUndefined();
  });

  test("closed event: the no-open-market answer", async () => {
    stubGamma();
    const r = await handleCommand(env, { tgId: 1n, chatId: 1n, cmd: "ifso", body: "@jake 20 if https://polymarket.com/event/fed-decision-in-december resolves yes" });
    expect(r.text).toBe(copy.parse.marketNoneOpen(CLOSED.title!));
  });

  test("rescore Info: a malformed link gets the plain answer, no Review button", async () => {
    stubGamma();
    const r = await handleCommand(env, { tgId: 1n, chatId: 1n, cmd: "ifso", body: "@jake 20 if https://polymarket.com/event/%E0%A4%A resolves yes" });
    expect(r.text).toBe(copy.parse.notPolymarketLink);
    expect(r.buttons).toBeUndefined();
  });

  test("/event/<e>/<m>: a normal preview", async () => {
    stubGamma();
    const r = await handleCommand(env, { tgId: 1n, chatId: 1n, cmd: "ifso", body: `@jake 20 if https://polymarket.com/event/${MANY.slug}/will-bitcoin-reach-95k-in-november-2026 resolves yes` });
    expect(r.text).toContain("Send 20 USDG to @jake");
    expect(r.buttons?.length).toBe(1);
  });
});
