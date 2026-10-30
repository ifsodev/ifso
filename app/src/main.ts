// Entrypoint: bun run src/main.ts <api|bot|worker|all>
import { loadEnv } from "./config/env";
import { makeClients } from "./chain";
import { createDb } from "./db/client";
import { createApp } from "./api/app";
import { RateLimiter } from "./api/rateLimit";
import { createBot, telegramSender } from "./bot/bot";
import { consoleLog, type Deps } from "./workers/deps";
import { QUEUES, makeQueue, makeWorker, redisConnection, scheduleTicks } from "./workers/queues";
import { keeperTick } from "./workers/keeper";
import { priceWatchTick } from "./workers/priceWatcher";
import { resolverTick } from "./workers/resolver";
import { indexerTick } from "./workers/indexer";
import { notifyEvent } from "./workers/notifier";

const role = process.argv[2] ?? "all";
const env = loadEnv();
const { db } = createDb(env.DATABASE_URL);
const deps: Deps = { env, db, clients: makeClients(env), log: consoleLog(role) };
const bot = createBot(deps);

if (role === "api" || role === "all") {
  const redis = redisConnection(env.REDIS_URL);
  const app = createApp(deps, new RateLimiter(redis), bot);
  Bun.serve({ port: env.PORT, fetch: app.fetch });
  deps.log(`api listening on :${env.PORT}`);
}

if (role === "bot" || (role === "all" && !env.TELEGRAM_WEBHOOK_SECRET)) {
  if (bot) {
    void bot.start({ drop_pending_updates: true }); // long polling for dev; production uses the webhook route
    deps.log("bot polling");
  }
}

if (role === "worker" || role === "all") {
  const conn = redisConnection(env.REDIS_URL);
  const send = bot ? telegramSender(bot) : async () => {};
  const notifyQ = makeQueue(QUEUES.notify, conn);
  const tick = (name: string, fn: () => Promise<void>, everyMs: number) => {
    const q = makeQueue(name, conn);
    void scheduleTicks(q, name, everyMs);
    makeWorker(name, conn, async () => fn());
  };
  tick(QUEUES.keeper, () => keeperTick(deps), 30_000);
  tick(QUEUES.priceWatch, () => priceWatchTick(deps), 15_000);
  tick(QUEUES.resolver, () => resolverTick(deps), 60_000);
  tick(QUEUES.indexer, () => indexerTick(deps, async (ev) => void (await notifyQ.add("event", JSON.parse(JSON.stringify(ev, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))))), 5_000);
  makeWorker<{ name: string; escrowId?: string; args: Record<string, unknown> }>(QUEUES.notify, conn, async (job) => notifyEvent(deps, send, job.data), 4);
  deps.log("workers started");
}
