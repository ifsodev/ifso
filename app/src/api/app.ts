import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { cors } from "hono/cors";
import { trpcServer } from "@hono/trpc-server";
import { eq } from "drizzle-orm";
import { webhookCallback, type Bot } from "grammy";
import { clientIp, trustedCountry } from "./clientIp";
import { questions } from "../db/schema";
import type { Deps } from "../workers/deps";
import { appRouter, jsonSafe } from "./router";
import { RateLimiter } from "./rateLimit";
import { readiness, type Probe } from "../ops/health";
import { userStats } from "./stats";
import { webhookPath } from "../bot/webhook";
import { stockPriceConditionAllowed } from "../core/geo";

export function createApp(deps: Deps, limiter: RateLimiter, bot?: Bot, probes: Record<string, Probe> = {}) {
  const app = new Hono();
  // strict headers; the claim page itself (web app) additionally ships a CSP with no third-party scripts
  app.use("*", secureHeaders({ referrerPolicy: "no-referrer", xFrameOptions: "DENY" }));

  // browser calls from the web app only (exact origins, no credentials); anything else gets no CORS headers
  const origins = new Set([new URL(deps.env.PUBLIC_APP_URL).origin, ...deps.env.WEB_ORIGINS.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean)]);
  app.use("*", cors({ origin: (o) => (origins.has(o) ? o : null), allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type", "trpc-accept"], maxAge: 600 }));

  app.get("/healthz", (c) => c.json({ ok: true, chainId: deps.clients.chain.id, escrow: deps.clients.escrow ?? null }));

  app.get("/readyz", async (c) => {
    const r = await readiness(probes);
    return c.json(r, r.ok ? 200 : 503);
  });

  // region rule for the site: the country comes from the trusted edge header only; unknown = not allowed
  app.get("/geo", (c) => {
    const country = trustedCountry(c.req.raw.headers, deps.env.TRUST_PROXY);
    c.header("cache-control", "no-store");
    return c.json({ country: country ?? null, stockPriceConditionsAllowed: stockPriceConditionAllowed(country) });
  });

  // real-user counter (indexed chain events only, our own wallets excluded). ?since=YYYY-MM-DD
  app.get("/stats/users", async (c) => {
    const since = c.req.query("since");
    if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return c.json({ error: "since must be YYYY-MM-DD" }, 400);
    // review R3-L1: same per-network read budget as the tRPC reads; the result itself is cached for 60 s
    const ip = clientIp(c.req.raw.headers, deps.env.TRUST_PROXY, (c.env as { socketIp?: string } | undefined)?.socketIp);
    if (!(await limiter.hit(`read:ip:${RateLimiter.ipHash(ip, deps.env.IP_HASH_SALT)}`, deps.env.READS_PER_IP_PER_HOUR, 3600))) return c.json({ error: "too many requests from this network, try again later" }, 429);
    return c.json(await userStats(deps, since ? Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000) : undefined));
  });

  // question specs are public (their hash is on-chain); served from the DB
  app.get("/q/:file", async (c) => {
    const specHash = c.req.param("file").replace(/\.json$/, "");
    const [q] = await deps.db.select().from(questions).where(eq(questions.specHash, specHash));
    return q ? c.json(jsonSafe(q.spec) as object) : c.notFound();
  });

  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      createContext: (_opts, c) => ({
        deps,
        limiter,
        ip: clientIp(c.req.raw.headers, deps.env.TRUST_PROXY, (c.env as { socketIp?: string } | undefined)?.socketIp),
        country: trustedCountry(c.req.raw.headers, deps.env.TRUST_PROXY),
      }),
    }),
  );

  // Telegram webhook: secret URL path + the X-Telegram-Bot-Api-Secret-Token header (a wrong or missing token is a 401)
  const path = webhookPath(deps.env);
  if (bot && path) app.post(path, webhookCallback(bot, "hono", { secretToken: deps.env.TELEGRAM_WEBHOOK_SECRET }));
  return app;
}
