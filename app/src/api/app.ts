import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { trpcServer } from "@hono/trpc-server";
import { eq } from "drizzle-orm";
import { webhookCallback, type Bot } from "grammy";
import { countryFromHeaders } from "../core/geo";
import { questions } from "../db/schema";
import type { Deps } from "../workers/deps";
import { appRouter, jsonSafe } from "./router";
import { RateLimiter } from "./rateLimit";
import { readiness, type Probe } from "../ops/health";

export function createApp(deps: Deps, limiter: RateLimiter, bot?: Bot, probes: Record<string, Probe> = {}) {
  const app = new Hono();
  // strict headers; the claim page itself (web app) additionally ships a CSP with no third-party scripts
  app.use("*", secureHeaders({ referrerPolicy: "no-referrer", xFrameOptions: "DENY" }));

  app.get("/healthz", (c) => c.json({ ok: true, chainId: deps.clients.chain.id, escrow: deps.clients.escrow ?? null }));

  app.get("/readyz", async (c) => {
    const r = await readiness(probes);
    return c.json(r, r.ok ? 200 : 503);
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
        ip: c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "0.0.0.0",
        country: countryFromHeaders(c.req.raw.headers),
      }),
    }),
  );

  if (bot && deps.env.TELEGRAM_WEBHOOK_SECRET) {
    app.post("/tg/webhook", webhookCallback(bot, "hono", { secretToken: deps.env.TELEGRAM_WEBHOOK_SECRET }));
  }
  return app;
}
