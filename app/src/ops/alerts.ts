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
  const claim =
    o.claim ??
    (async (cause: string, ttl: number) => {
      const last = seen.get(cause);
      if (last !== undefined && now() - last < ttl) return false;
      seen.set(cause, now());
      return true;
    });
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

export const alertFromEnv = (env: Env, log: AlertOptions["log"], extra: Partial<AlertOptions> = {}): AlertFn =>
  makeAlert({ armed: env.ALERTS_ARMED === "1", token: env.OPS_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN, chatId: env.OPS_CHAT_ID, log, ...extra });
