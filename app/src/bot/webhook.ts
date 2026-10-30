// The webhook lives at a path only we and Telegram know, and Telegram also sends the secret header (checked by grammY).
import { createHash } from "node:crypto";

/** /tg/<path>: derived from the webhook secret and the bot token, so changing either moves the URL. */
export function webhookPath(env: { TELEGRAM_WEBHOOK_SECRET?: string; TELEGRAM_BOT_TOKEN?: string }): string | undefined {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return undefined;
  const h = createHash("sha256").update(`tg-path:${env.TELEGRAM_WEBHOOK_SECRET}:${env.TELEGRAM_BOT_TOKEN ?? ""}`).digest("hex").slice(0, 32);
  return `/tg/${h}`;
}
