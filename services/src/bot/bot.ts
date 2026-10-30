// Plain Telegram bot (NO Mini App): Telegram's bot-developer terms §7 restrict Mini Apps with crypto features to
// TON; regular bots without a Mini App are exempt. So the bot only parses, previews and hands off to the
// external web app through ordinary URL buttons, where the user signs with their own wallet / passkey.
// The bot never holds keys, funds, or link secrets.
import { Bot, InlineKeyboard, type Context } from "grammy";
import { desc, eq, inArray } from "drizzle-orm";
import { copy } from "../core/copy";
import { formatUsdg } from "../core/money";
import { parseCommand } from "../core/parser";
import { Status } from "../core/types";
import { SEED_FEEDS } from "../config/chain";
import { escrows, intents, tgUsers, watchers } from "../db/schema";
import type { Deps } from "../workers/deps";

export function createBot(deps: Deps): Bot | undefined {
  if (!deps.env.TELEGRAM_BOT_TOKEN) return undefined;
  const bot = new Bot(deps.env.TELEGRAM_BOT_TOKEN);
  const tickers = new Set(SEED_FEEDS.map((f) => f.ticker));

  bot.command("start", (ctx) => ctx.reply(copy.bot.welcome));
  bot.command("help", (ctx) => ctx.reply(`${copy.bot.help}\n\n${copy.parse.usage}`));

  const handle = async (ctx: Context, cmd: "ifso" | "challenge") => {
    const from = ctx.from;
    if (!from || !ctx.chat) return;
    const body = (ctx.match as string | undefined) ?? "";
    const user = await deps.db.select().from(tgUsers).where(eq(tgUsers.tgId, BigInt(from.id)));
    const tz = user[0]?.tzOffsetMin ?? 0;
    const text = `/${cmd} ${body}`;
    const r = parseCommand(text, { nowMs: Date.now(), tzOffsetMin: tz, tickers });
    if (r.errors.length) return ctx.reply(r.errors.join("\n"));
    if (r.ambiguities.length) return ctx.reply(r.ambiguities.map((q) => copy.bot.askAmbiguity(q)).join("\n"));
    if (!r.ok || !r.condition) return ctx.reply(copy.parse.usage);

    await deps.db.insert(tgUsers).values({ tgId: BigInt(from.id), username: from.username ?? null }).onConflictDoNothing();
    const [it] = await deps.db
      .insert(intents)
      .values({
        tgId: BigInt(from.id),
        tgChatId: BigInt(ctx.chat.id),
        text,
        draft: r.condition,
        recipientHandle: r.recipient?.type === "handle" ? r.recipient.handle : null,
      })
      .returning({ id: intents.id });
    const kb = new InlineKeyboard().url(copy.bot.confirmButton, `${deps.env.PUBLIC_APP_URL}/new/${it!.id}`);
    const notes = r.notes.length ? `\n\n${r.notes.map((n) => `• ${n}`).join("\n")}` : "";
    return ctx.reply(`${r.preview}${notes}`, { reply_markup: kb });
  };

  bot.command("ifso", (ctx) => handle(ctx, "ifso"));
  bot.command("challenge", (ctx) => handle(ctx, "challenge"));

  bot.command("mine", async (ctx) => {
    if (!ctx.chat) return;
    const ws = await deps.db.select({ id: watchers.escrowId }).from(watchers).where(eq(watchers.tgChatId, BigInt(ctx.chat.id)));
    if (!ws.length) return ctx.reply("No if-so payments yet.");
    const rows = await deps.db.select().from(escrows).where(inArray(escrows.id, ws.map((w) => w.id))).orderBy(desc(escrows.createdBlock)).limit(10);
    const lines = rows.map((e) => `${formatUsdg(BigInt(e.amount))} USDG · ${Status[e.status]?.toLowerCase()} · comes back ${e.expiry.toISOString().slice(0, 10)}`);
    const kb = new InlineKeyboard().url(copy.bot.openButton, `${deps.env.PUBLIC_APP_URL}/mine`);
    return ctx.reply(lines.join("\n"), { reply_markup: kb });
  });

  bot.command("tz", async (ctx) => {
    const m = String(ctx.match ?? "").match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!m || !ctx.from) return ctx.reply("Set your time zone like /tz +4 or /tz -5:00");
    const mins = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
    await deps.db.insert(tgUsers).values({ tgId: BigInt(ctx.from.id), tzOffsetMin: mins }).onConflictDoUpdate({ target: tgUsers.tgId, set: { tzOffsetMin: mins } });
    return ctx.reply(`Time zone set to UTC${m[1]}${m[2]}${m[3] ? ":" + m[3] : ""}.`);
  });

  bot.catch((err) => deps.log("bot error", { err: String(err.error) }));
  return bot;
}

export function telegramSender(bot: Bot) {
  return async (chatId: bigint, text: string) => {
    await bot.api.sendMessage(Number(chatId), text);
  };
}
