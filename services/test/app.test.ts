// Boots the real Hono + tRPC app in-process (no network, no DB queries on these routes).
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/api/app";
import { RateLimiter } from "../src/api/rateLimit";
import { makeClients } from "../src/chain";
import { loadEnv } from "../src/config/env";
import { createDb } from "../src/db/client";
import type { Deps } from "../src/workers/deps";

const env = loadEnv({ ESCROW_ADDRESS: "0x00000000000000000000000000000000000e5c20" });
const deps: Deps = { env, db: createDb(env.DATABASE_URL).db, clients: makeClients(env), log: () => {} };
const app = createApp(deps, new RateLimiter());
const q = (input: unknown) => `/trpc/parse?input=${encodeURIComponent(JSON.stringify(input))}`;

describe("api smoke", () => {
  test("healthz + security headers", async () => {
    const r = await app.request("/healthz");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, chainId: 4663 });
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("tRPC parse returns a preview", async () => {
    const r = await app.request(q({ text: "/ifso @jake 20 if arsenal win" }), { headers: { "cf-ipcountry": "DE" } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: { data: { ok: boolean; preview: string } } };
    expect(body.result.data.ok).toBe(true);
    expect(body.result.data.preview).toContain("Send 20 USDG to @jake");
  });

  test("stock price conditions are gated by region (AE), allowed elsewhere (DE)", async () => {
    const text = "/ifso @mia 100 if nvda closes above 200 by 2030-01-04";
    const blocked = (await (await app.request(q({ text }), { headers: { "cf-ipcountry": "AE" } })).json()) as { result: { data: { errors: string[] } } };
    expect(blocked.result.data.errors.join(" ")).toContain("aren't available in your region");
    const ok = (await (await app.request(q({ text }), { headers: { "cf-ipcountry": "DE" } })).json()) as { result: { data: { errors: string[] } } };
    expect(ok.result.data.errors).toEqual([]);
  });

  test("crypto price conditions (ETH) are not region-gated", async () => {
    const r = (await (await app.request(q({ text: "/ifso @mia 100 if eth closes above 3000 by 2030-01-04" }), { headers: { "cf-ipcountry": "US" } })).json()) as { result: { data: { errors: string[] } } };
    expect(r.result.data.errors).toEqual([]);
  });
});
