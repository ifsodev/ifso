// Entrypoint: bun run src/main.ts <api|bot|worker|all>
import { EnvError, ROLES, loadEnv, type Role } from "./config/env";
import { KeyError } from "./chain/keys";
import { alertFromEnv } from "./ops/alerts";
import { defaultProbes } from "./ops/health";
import { runMonitors } from "./ops/monitors";
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

const role = (process.argv[2] ?? "all") as Role;
if (!ROLES.includes(role)) {
  console.error(`unknown role "${role}" (use ${ROLES.join(" | ")})`);
  process.exit(1);
}
const log = consoleLog(role);
let env: ReturnType<typeof loadEnv>;
let clients: ReturnType<typeof makeClients>;
let alert: ReturnType<typeof alertFromEnv>;
try {
  env = loadEnv(process.env, role); // fails fast, names only
  alert = alertFromEnv(env, log);
  clients = makeClients(env, { onFailover: (i) => void alert("rpc-failover", `primary RPC failing, using a backup (${i.from})`) });
} catch (e) {
  if (e instanceof EnvError || e instanceof KeyError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
const { db } = createDb(env.DATABASE_URL);
const deps: Deps = { env, db, clients, log };
const bot = createBot(deps);

if (role === "api" || role === "all") {
  const redis = redisConnection(env.REDIS_URL);
  const app = createApp(deps, new RateLimiter(redis), bot, defaultProbes(deps, redis));
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
  setInterval(() => void runMonitors(deps, alert).catch((e) => deps.log("monitor failed", { error: String(e?.message ?? e) })), 60_000);
  deps.log("workers started");
}
