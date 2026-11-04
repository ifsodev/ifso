// Gamma's list endpoint (`/markets?slug=`) leaves CLOSED markets out unless `closed=true` is passed (checked live on
// 2026-11-04: a resolved market returned [] without it). A resolved market is exactly the one the resolver must read, so the
// fetcher must use the single-market endpoint `/markets/slug/<slug>`, which answers for open and closed markets alike and
// 404s for an unknown slug. This stub copies the live API's behaviour.
import { afterEach, describe, expect, test } from "bun:test";
import { fetchGamma } from "../src/sources/polymarket";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CH = `0x${"ab".repeat(32)}` as `0x${string}`;
const markets: Record<string, object> = {
  "resolved-yes": { slug: "resolved-yes", question: "q", conditionId: CH, closed: true, umaResolutionStatus: "resolved", outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' },
  "still-open": { slug: "still-open", question: "q", conditionId: CH, closed: false, outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]' },
};

function liveLikeGamma(): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    seen.push(url.toString());
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const one = url.pathname.match(/^\/markets\/slug\/(.+)$/);
    if (one) {
      const m = markets[decodeURIComponent(one[1]!)];
      return m ? json(200, m) : json(404, { type: "not found error", error: "slug not found" });
    }
    if (url.pathname === "/markets") {
      const m = markets[url.searchParams.get("slug") ?? ""] as { closed?: boolean } | undefined;
      const wantClosed = url.searchParams.get("closed") === "true";
      return json(200, m && Boolean(m.closed) === wantClosed ? [m] : []);
    }
    return json(404, {});
  }) as typeof fetch;
  return seen;
}

describe("Gamma fetcher on the live API's shape", () => {
  test("a RESOLVED (closed) market is read as final, not pending", async () => {
    liveLikeGamma();
    const r = await fetchGamma("resolved-yes");
    expect(r.report).toMatchObject({ provider: "polymarket-gamma", status: "final", outcome: 1 });
    expect(r.market?.conditionId).toBe(CH);
  });

  test("an open market is still found (pending, with its conditionId)", async () => {
    liveLikeGamma();
    const r = await fetchGamma("still-open");
    expect(r.report.status).toBe("pending");
    expect(r.market?.conditionId).toBe(CH);
  });

  test("an unknown slug is pending with no market, never a thrown 404", async () => {
    const seen = liveLikeGamma();
    const r = await fetchGamma("no such/slug");
    expect(r.report.status).toBe("pending");
    expect(r.market).toBeUndefined();
    expect(seen[0]).toContain("/markets/slug/no%20such%2Fslug");
  });
});
