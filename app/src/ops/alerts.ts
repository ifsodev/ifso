// Ops alerts to the Telegram ops chat. One message per cause per 30 minutes. Log-only unless ALERTS_ARMED=1.
// Alert text is built from fixed templates and ids; never put user message text in it.
import type { Env } from "../config/env";

export const ALERT_DEDUPE_MS = 30 * 60 * 1000;

/**
 * Self-healing causes: raised and logged (cause and text length), never sent and never claimed. The rule is to alert
 * only when someone must act; an RPC failover and an indexer reorg rewind both recover on their own.
 */
export const LOG_ONLY_CAUSES: ReadonlySet<string> = new Set(["rpc-failover", "indexer-reorg"]);

/**
 * Resolves true when the alert was handled as configured: sent to Telegram, or written to the log because alerts are
 * not armed (log-only is the configured sink, so a caller waiting for delivery must not stall forever on it). False
 * when it was not delivered: a failed send, or the cause was already claimed in the last 30 minutes.
 */
export type AlertFn = (cause: string, text: string) => Promise<boolean>;

/** The one Redis command the shared claim needs (ioredis `set(key, value, "PX", ms, "NX")`). */
export interface ClaimStore {
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<string | null>;
}
export const ALERT_CLAIM_PREFIX = "ifso:alert:";
const CLAIM_TIMEOUT_MS = 2_000;

/** Cross-process dedupe: the first process to SET NX the cause's key sends; the key expires after the window. */
export const redisClaim =
  (store: ClaimStore) =>
  async (cause: string, ttlMs: number): Promise<boolean> =>
    (await store.set(ALERT_CLAIM_PREFIX + cause, "1", "PX", ttlMs, "NX")) === "OK";

export interface AlertOptions {
  armed: boolean;
  token?: string;
  chatId?: string;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Shared dedupe (e.g. Redis SET NX) so several processes do not repeat one cause. Defaults to memory. */
  claim?: (cause: string, ttlMs: number) => Promise<boolean>;
}

export function makeAlert(o: AlertOptions): AlertFn {
  const now = o.now ?? Date.now;
  const seen = new Map<string, number>();
  const memory = async (cause: string, ttl: number) => {
    const last = seen.get(cause);
    if (last !== undefined && now() - last < ttl) return false;
    seen.set(cause, now());
    return true;
  };
  const shared = o.claim;
  // A failing or slow shared store must not swallow an alert: fall back to this process's memory (worst case a repeat).
  const claim = !shared
    ? memory
    : async (cause: string, ttl: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("claim timeout")), CLAIM_TIMEOUT_MS)));
          return await Promise.race([shared(cause, ttl), timeout]);
        } catch (e) {
          o.log("alert claim failed; using memory dedupe", { cause, error: String((e as Error)?.message ?? e) });
          return memory(cause, ttl);
        } finally {
          clearTimeout(timer);
        }
      };
  return async (cause, text) => {
    if (LOG_ONLY_CAUSES.has(cause)) {
      o.log("alert (log-only: self-healing)", { cause, length: text.length, text });
      return true;
    }
    if (!(await claim(cause, ALERT_DEDUPE_MS))) return false;
    if (!o.armed || !o.token || !o.chatId) {
      o.log("alert (not sent: unarmed)", { cause, text });
      return true; // audit I-10: log-only is the configured delivery while unarmed
    }
    try {
      const res = await (o.fetchImpl ?? fetch)(`https://api.telegram.org/bot${o.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: o.chatId, text: `[ifso ops] ${cause}: ${text}`, disable_web_page_preview: true }),
      });
      if (!res.ok) o.log("alert send failed", { cause, status: res.status });
      return res.ok;
    } catch (e) {
      o.log("alert send failed", { cause, error: String((e as Error).message).replace(o.token, "***") });
      return false;
    }
  };
}

/** The alert for one process. With a store (Redis), api and worker share one dedupe; without (tests, bot), memory. */
export const alertFromEnv = (env: Env, log: AlertOptions["log"], extra: Partial<AlertOptions> = {}, store?: ClaimStore): AlertFn =>
  makeAlert({ armed: env.ALERTS_ARMED === "1", token: env.OPS_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN, chatId: env.OPS_CHAT_ID, log, ...(store ? { claim: redisClaim(store) } : {}), ...extra });
