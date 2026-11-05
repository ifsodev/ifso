// Plain Telegram bot (NO Mini App): Telegram's bot-developer terms §7 restrict Mini Apps with crypto features to
// TON; regular bots without a Mini App are exempt. So the bot only parses, previews and hands off to the
// external web app through ordinary URL buttons, where the user signs with their own wallet / passkey.
// The bot never holds keys, funds, or link secrets, and never logs message text.
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { copy } from "../core/copy";
import { SEED_FEEDS } from "../config/chain";
import { listFixtureMatches } from "../api/fixtures";
import { resolvePolymarketRef } from "../sources/polymarket";
import type { Deps } from "../workers/deps";
import { handleAnswer, handleCommand, handleLink, handleMine, handleTz, type FixtureLookup, type FlowEnv, type Reply } from "./flow";
import { drizzleBotStore, type BotStore } from "./store";

export interface BotOptions {
  store?: BotStore;
  fixtures?: FixtureLookup;
  /** skips the getMe call (tests); production leaves it unset */
  botInfo?: UserFromGetMe;
  /** commands per user per minute */
  perMinute?: number;
  now?: () => number;
}

function keyboard(r: Reply): InlineKeyboard | undefined {
  if (!r.buttons?.length) return undefined;
  const kb = new InlineKeyboard();
  r.buttons.forEach((row, i) => {
    if (i) kb.row();
    for (const b of row) "url" in b ? kb.url(b.text, b.url) : kb.text(b.text, b.data);
  });
  return kb;
}

export function createBot(deps: Deps, opts: BotOptions = {}): Bot | undefined {
  if (!deps.env.TELEGRAM_BOT_TOKEN) return undefined;
  const bot = new Bot(deps.env.TELEGRAM_BOT_TOKEN, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
  const flow: FlowEnv = {
    store: opts.store ?? drizzleBotStore(deps.db),
    publicAppUrl: deps.env.PUBLIC_APP_URL,
    tickers: new Set(SEED_FEEDS.map((f) => f.ticker)),
    stockTickers: new Set(SEED_FEEDS.filter((f) => f.isStock).map((f) => f.ticker)),
    fixtures: opts.fixtures ?? ((team, opp, on) => listFixtureMatches(deps, team, opp, on)),
    polymarket: (ref) => resolvePolymarketRef(ref),
    now: opts.now,
  };

  // a small per-user brake so one chat cannot flood the parser or the fixture lookup
  const hits = new Map<number, number[]>();
  const limit = opts.perMinute ?? 12;
  const tooMany = (id: number) => {
    const t = (opts.now ?? Date.now)();
    const recent = (hits.get(id) ?? []).filter((x) => t - x < 60_000);
    recent.push(t);
    hits.set(id, recent);
    if (hits.size > 5000) hits.clear();
    return recent.length > limit;
  };

  const send = async (ctx: Context, r: Reply) => {
    const kb = keyboard(r);
    await ctx.reply(r.text, kb ? { reply_markup: kb } : undefined);
  };

  bot.command("start", (ctx) => ctx.reply(copy.bot.welcome));
  bot.command("help", (ctx) => ctx.reply(`${copy.bot.help}\n\n${copy.parse.usage}`));

  const command = (cmd: "ifso" | "challenge") => async (ctx: Context) => {
    if (!ctx.from || !ctx.chat) return;
    if (tooMany(ctx.from.id)) return void (await ctx.reply(copy.bot.busy));
    const r = await handleCommand(flow, { tgId: BigInt(ctx.from.id), chatId: BigInt(ctx.chat.id), username: ctx.from.username, cmd, body: String(ctx.match ?? "") });
    await send(ctx, r);
  };
  bot.command("ifso", command("ifso"));
  bot.command("challenge", command("challenge"));

  bot.command("mine", async (ctx) => {
    if (!ctx.from || !ctx.chat) return;
    await send(ctx, await handleMine(flow, { tgId: BigInt(ctx.from.id), chatId: BigInt(ctx.chat.id) }));
  });

  bot.command("link", async (ctx) => {
    if (!ctx.from || !ctx.chat) return;
    if (tooMany(ctx.from.id)) return void (await ctx.reply(copy.bot.busy));
    await send(ctx, await handleLink(flow, { tgId: BigInt(ctx.from.id), username: ctx.from.username, isPrivate: ctx.chat.type === "private" }));
  });

  bot.command("tz", async (ctx) => {
    if (!ctx.from) return;
    await send(ctx, await handleTz(flow, { tgId: BigInt(ctx.from.id), username: ctx.from.username, arg: String(ctx.match ?? "") }));
  });

  bot.callbackQuery(/^q:([0-9a-f-]{36}):(\d{1,2})$/, async (ctx) => {
    const m = ctx.match as RegExpMatchArray;
    const res = await handleAnswer(flow, { tgId: BigInt(ctx.from.id), chatId: BigInt(ctx.chat?.id ?? ctx.from.id), intentId: m[1]!, option: Number(m[2]) });
    await ctx.answerCallbackQuery(res.toast ? { text: res.toast } : undefined);
    if (res.reply) {
      const kb = keyboard(res.reply);
      await ctx.editMessageText(res.reply.text, kb ? { reply_markup: kb } : undefined).catch(() => send(ctx, res.reply!));
    }
  });

  // never log message text: only the error class and Telegram's own description
  bot.catch((err) => deps.log("bot error", { err: String((err.error as Error)?.name ?? "error"), update: err.ctx.update.update_id }));
  return bot;
}

export function telegramSender(bot: Bot) {
  return async (chatId: bigint, text: string) => {
    await bot.api.sendMessage(Number(chatId), text);
  };
}
