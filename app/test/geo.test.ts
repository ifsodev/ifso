// R3: /geo reports the country from the trusted edge header and blocks each listed country and unknown.
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/api/app";
import { RateLimiter } from "../src/api/rateLimit";
import { loadEnv } from "../src/config/env";
import { PRICE_GATED_COUNTRIES } from "../src/core/geo";
import type { Deps } from "../src/workers/deps";

const mk = (proxy: string) => createApp({ env: loadEnv({ ESCROW_ADDRESS: "0x00000000000000000000000000000000000e5c20", TRUST_PROXY: proxy }), log: () => {}, db: undefined as never, clients: { chain: { id: 4663 } } as never } as Deps, new RateLimiter());
const geo = async (app: ReturnType<typeof mk>, headers: Record<string, string> = {}) => {
  const r = await app.request("/geo", { headers });
  return { status: r.status, cache: r.headers.get("cache-control"), body: (await r.json()) as { country: string | null; stockPriceConditionsAllowed: boolean } };
};

describe("/geo", () => {
  test("the block list is exactly GB and CH (DECISIONS #41)", () => expect([...PRICE_GATED_COUNTRIES].sort()).toEqual(["CH", "GB"]));
  for (const c of ["GB", "CH"]) {
    test(`${c} is blocked (cloudflare header)`, async () => {
      const r = await geo(mk("cloudflare"), { "cf-ipcountry": c });
      expect(r.body).toEqual({ country: c, stockPriceConditionsAllowed: false });
    });
  }
  test("an allowed country passes; lower case is normalised; never cached", async () => {
    const r = await geo(mk("cloudflare"), { "cf-ipcountry": "de" });
    expect(r.status).toBe(200);
    expect(r.cache).toBe("no-store");
    expect(r.body).toEqual({ country: "DE", stockPriceConditionsAllowed: true });
  });
  test("vercel header is read in vercel mode only", async () => {
    expect((await geo(mk("vercel"), { "x-vercel-ip-country": "FR" })).body.stockPriceConditionsAllowed).toBe(true);
    expect((await geo(mk("cloudflare"), { "x-vercel-ip-country": "FR" })).body).toEqual({ country: null, stockPriceConditionsAllowed: false });
  });
  test("unknown fails closed: no header, XX, junk, an untrusted x-country, and TRUST_PROXY=none", async () => {
    const cf = mk("cloudflare");
    for (const h of [{} as Record<string, string>, { "cf-ipcountry": "XX" }, { "cf-ipcountry": "Germany" }, { "x-country": "DE" }]) expect((await geo(cf, h)).body).toEqual({ country: null, stockPriceConditionsAllowed: false });
    expect((await geo(mk("none"), { "cf-ipcountry": "DE" })).body).toEqual({ country: null, stockPriceConditionsAllowed: false });
  });
});

describe("CORS for the web app", () => {
  const app = createApp({ env: loadEnv({ ESCROW_ADDRESS: "0x00000000000000000000000000000000000e5c20", PUBLIC_APP_URL: "https://app.example", WEB_ORIGINS: "https://preview.example/, https://b.example" }), log: () => {}, db: undefined as never, clients: { chain: { id: 4663 } } as never } as Deps, new RateLimiter());
  test("the app's own origin and the listed origins are allowed, others get no header", async () => {
    for (const o of ["https://app.example", "https://preview.example", "https://b.example"]) expect((await app.request("/geo", { headers: { origin: o } })).headers.get("access-control-allow-origin")).toBe(o);
    expect((await app.request("/geo", { headers: { origin: "https://evil.example" } })).headers.get("access-control-allow-origin")).toBeNull();
  });
  test("a preflight for a tRPC call is answered", async () => {
    const r = await app.request("/trpc/build", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(r.status).toBeLessThan(300);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });
});
