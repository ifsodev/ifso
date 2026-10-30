// Runs the real grammY bot with no network: outgoing Bot API calls are captured, the store lives in memory.
import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";
import type { Update } from "grammy/types";
import { makeClients } from "../../src/chain";
import { loadEnv } from "../../src/config/env";
import { createDb } from "../../src/db/client";
import { createBot } from "../../src/bot/bot";
import type { FixtureLookup } from "../../src/bot/flow";
import type { BotStore, IntentRow, IntentPatch, MineRow } from "../../src/bot/store";
import type { Deps } from "../../src/workers/deps";

export const NOW_MS = Date.UTC(2026, 9, 21, 12, 0); // Wed 2026-10-21 12:00 UTC

export class MemoryStore implements BotStore {
  users = new Map<bigint, { tz: string | null; tzOffsetMin: number; username?: string | null }>();
  intents = new Map<string, IntentRow & { tgChatId: bigint; recipientHandle: string | null; tzOffsetMin: number | null }>();
  mineRows: MineRow[] = [];
  async getUser(id: bigint) {
    return this.users.get(id);
  }
  async upsertUser(id: bigint, patch: { username?: string | null; tz?: string | null; tzOffsetMin?: number }) {
    const cur = this.users.get(id) ?? { tz: null, tzOffsetMin: 0 };
    this.users.set(id, { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  }
  async createIntent(row: { tgId: bigint; tgChatId: bigint; text: string; draft: unknown; recipientHandle: string | null; tzOffsetMin: number | null }) {
    const id = randomUUID();
    this.intents.set(id, { id, ...row, expiresAt: new Date(NOW_MS + 24 * 3600_000) });
    return { id };
  }
  async getIntent(id: string) {
    return this.intents.get(id);
  }
  async updateIntent(id: string, patch: IntentPatch) {
    const cur = this.intents.get(id)!;
    this.intents.set(id, { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as never);
  }
  async mine() {
    return this.mineRows;
  }
}

export interface Sent {
  method: string;
  payload: Record<string, any>;
}

/** Stand-in for the fixture lookup: one next fixture for most teams, two teams for "manchester", none for "nowhere fc". */
export const stubFixtures: FixtureLookup = async (team) => {
  const t = team.toLowerCase();
  const cap = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const at = Math.floor(NOW_MS / 1000) + 3 * 86400;
  if (t === "nowhere fc") return [];
  if (t === "manchester")
    return [
      { home: "Manchester City", away: "Fulham", league: "Premier League", commence: at, matched: "Manchester City" },
      { home: "Leeds", away: "Manchester United", league: "Premier League", commence: at + 86400, matched: "Manchester United" },
    ];
  return [{ home: cap(team), away: "Opponent FC", league: "Premier League", commence: at, matched: cap(team) }];
};

export function makeHarness(over: { fixtures?: FixtureLookup; now?: () => number } = {}) {
  const env = loadEnv({
    ESCROW_ADDRESS: "0x00000000000000000000000000000000000e5c20",
    TELEGRAM_BOT_TOKEN: "123456:TEST-TOKEN",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    PUBLIC_APP_URL: "https://ifso.test",
  });
  const deps: Deps = { env, db: createDb(env.DATABASE_URL).db, clients: makeClients(env), log: () => {} };
  const store = new MemoryStore();
  const bot = createBot(deps, {
    store,
    fixtures: over.fixtures ?? stubFixtures,
    now: over.now ?? (() => NOW_MS),
    botInfo: { id: 42, is_bot: true, first_name: "Ifso", username: "ifso_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never,
    perMinute: 10_000,
  }) as Bot;
  const sent: Sent[] = [];
  let mid = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, any> });
    if (method === "sendMessage" || method === "editMessageText")
      return { ok: true, result: { message_id: ++mid, date: 0, chat: { id: (payload as any).chat_id ?? 1, type: "private" }, text: "" } } as never;
    return { ok: true, result: true } as never;
  });
  let uid = 1;
  const say = async (text: string, o: { userId?: number; chatId?: number; chatType?: "private" | "group" } = {}) => {
    const userId = o.userId ?? 7;
    const chatId = o.chatId ?? userId;
    const cmd = text.match(/^\/\S+/)?.[0] ?? "";
    const update: Update = {
      update_id: uid++,
      message: {
        message_id: uid,
        date: Math.floor(NOW_MS / 1000),
        chat: { id: chatId, type: o.chatType ?? "private" } as never,
        from: { id: userId, is_bot: false, first_name: "T", username: `user${userId}` },
        text,
        entities: cmd ? [{ type: "bot_command", offset: 0, length: cmd.length }] : [],
      },
    };
    const before = sent.length;
    await bot.handleUpdate(update);
    return sent.slice(before);
  };
  const press = async (data: string, o: { userId?: number; chatId?: number } = {}) => {
    const userId = o.userId ?? 7;
    const before = sent.length;
    await bot.handleUpdate({
      update_id: uid++,
      callback_query: {
        id: String(uid),
        chat_instance: "x",
        from: { id: userId, is_bot: false, first_name: "T" },
        data,
        message: { message_id: 5, date: 0, chat: { id: o.chatId ?? userId, type: "private" }, text: "q" } as never,
      },
    });
    return sent.slice(before);
  };
  return { bot, deps, store, sent, say, press, env };
}

/** The text a reply showed (sendMessage or editMessageText) and its buttons, flattened. */
export const textOf = (s: Sent[]) => s.filter((x) => x.method === "sendMessage" || x.method === "editMessageText").map((x) => x.payload.text as string).join("\n");
export const buttonsOf = (s: Sent[]): any[] =>
  s.flatMap((x) => (x.payload.reply_markup?.inline_keyboard as any[][] | undefined)?.flat() ?? []);
