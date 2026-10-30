// Ops alerts to the Telegram ops chat. One message per cause per 30 minutes. Log-only unless ALERTS_ARMED=1.
// Alert text is built from fixed templates and ids; never put user message text in it.
import type { Env } from "../config/env";

export const ALERT_DEDUPE_MS = 30 * 60 * 1000;

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
    if (!(await claim(cause, ALERT_DEDUPE_MS))) return false;
    if (!o.armed || !o.token || !o.chatId) {
      o.log("alert (not sent: unarmed)", { cause, text });
      return false;
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
