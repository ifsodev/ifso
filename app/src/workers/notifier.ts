// Notifier: turns indexed events into Telegram messages for watchers (sender's chat; recipients who opted in).
// Uses only copy.ts strings. Never includes claim links (the bot never sees link secrets).
import { eq } from "drizzle-orm";
import { copy } from "../core/copy";
import { formatUsdg } from "../core/money";
import { watchers } from "../db/schema";
import type { Deps } from "./deps";

export type Sender = (chatId: bigint, text: string) => Promise<void>;

export async function notifyEvent(
  deps: Deps,
  send: Sender,
  ev: { name: string; escrowId?: string; args: Record<string, unknown> },
) {
  if (!ev.escrowId) return;
  const text = render(ev.name, ev.args);
  if (!text) return;
  const ws = await deps.db.select().from(watchers).where(eq(watchers.escrowId, ev.escrowId));
  for (const w of ws) {
    try {
      await send(w.tgChatId, text);
    } catch (e) {
      deps.log("telegram send failed", { chat: String(w.tgChatId), err: String(e) });
    }
  }
}

export function render(name: string, a: Record<string, unknown>): string | undefined {
  const amt = (k: string) => formatUsdg(BigInt(String(a[k] ?? 0)));
  switch (name) {
    case "Met":
      return copy.bot.met;
    case "Released":
      return copy.bot.released(amt("amount"), shortAddr(String(a.to)));
    case "Returned":
      return copy.bot.returned(amt("amount"));
    case "Voided":
      return copy.bot.voided;
    default:
      return undefined;
  }
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
