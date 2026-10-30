import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
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

export function createApp(deps: Deps, limiter: RateLimiter, bot?: Bot, probes: Record<string, Probe> = {}) {
  const app = new Hono();
  // strict headers; the claim page itself (web app) additionally ships a CSP with no third-party scripts
  app.use("*", secureHeaders({ referrerPolicy: "no-referrer", xFrameOptions: "DENY" }));

  app.get("/healthz", (c) => c.json({ ok: true, chainId: deps.clients.chain.id, escrow: deps.clients.escrow ?? null }));

  app.get("/readyz", async (c) => {
    const r = await readiness(probes);
    return c.json(r, r.ok ? 200 : 503);
  });

  // real-user counter (indexed chain events only, our own wallets excluded). ?since=YYYY-MM-DD
  app.get("/stats/users", async (c) => {
    const since = c.req.query("since");
    if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return c.json({ error: "since must be YYYY-MM-DD" }, 400);
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
