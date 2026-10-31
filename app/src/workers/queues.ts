import { Queue, Worker, type Processor } from "bullmq";
import IORedis from "ioredis";

export const QUEUES = {
  keeper: "ifso-keeper",
  priceWatch: "ifso-price-watch",
  resolver: "ifso-resolver",
  indexer: "ifso-indexer",
  notify: "ifso-notify",
  adminWatch: "ifso-admin-watch",
} as const;

export function redisConnection(url: string) {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export function makeQueue(name: string, connection: IORedis) {
  return new Queue(name, { connection, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000, attempts: 3, backoff: { type: "exponential", delay: 5000 } } });
}

export function makeWorker<T>(name: string, connection: IORedis, fn: Processor<T>, concurrency = 1) {
  return new Worker<T>(name, fn, { connection, concurrency });
}

/** Repeatable "tick" jobs (no Chainlink Automation / Gelato on RHC mainnet: keepers are self-hosted). */
export async function scheduleTicks(q: Queue, name: string, everyMs: number) {
  await q.upsertJobScheduler(`${name}-tick`, { every: everyMs }, { name, data: {} });
}
