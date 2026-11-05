// The webhook lives at a path only we and Telegram know, and Telegram also sends the secret header (checked by grammY).
import { createHash, timingSafeEqual } from "node:crypto";

/** /tg/<path>: derived from the webhook secret and the bot token, so changing either moves the URL. */
export function webhookPath(env: { TELEGRAM_WEBHOOK_SECRET?: string; TELEGRAM_BOT_TOKEN?: string }): string | undefined {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return undefined;
  const h = createHash("sha256").update(`tg-path:${env.TELEGRAM_WEBHOOK_SECRET}:${env.TELEGRAM_BOT_TOKEN ?? ""}`).digest("hex").slice(0, 32);
  return `/tg/${h}`;
}

/**
 * Audit I-17: the X-Telegram-Bot-Api-Secret-Token header compared in constant time (both sides hashed to 32 bytes
 * first, so the length does not leak either). grammY's own `!==` check then only ever sees the right token.
 */
export function webhookTokenOk(header: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || header == null) return false;
  const h = (x: string) => createHash("sha256").update(x).digest();
  return timingSafeEqual(h(header), h(secret));
}
