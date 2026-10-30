// Storage the bot needs, behind an interface so the command flow is testable without a database.
import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { escrows, intents, linkRequests, tgUsers, watchers } from "../db/schema";
import { LINK_TOKEN_TTL_SEC } from "../core/linkWallet";
import { newLinkToken, tokenHash } from "../api/linkToken";
import type { Db } from "../db/client";

export interface BotUser {
  tz: string | null;
  tzOffsetMin: number;
}

export interface IntentRow {
  id: string;
  tgId: bigint | null;
  text: string | null;
  draft: unknown;
  expiresAt: Date;
}

export interface IntentPatch {
  text?: string;
  draft?: unknown;
  recipientHandle?: string | null;
  tzOffsetMin?: number | null;
}

export interface MineRow {
  amount: string;
  status: number;
  expiry: Date;
}

export interface BotStore {
  getUser(tgId: bigint): Promise<BotUser | undefined>;
  upsertUser(tgId: bigint, patch: { username?: string | null; tz?: string | null; tzOffsetMin?: number }): Promise<void>;
  createIntent(row: { tgId: bigint; tgChatId: bigint; text: string; draft: unknown; recipientHandle: string | null; tzOffsetMin: number | null }): Promise<{ id: string }>;
  getIntent(id: string): Promise<IntentRow | undefined>;
  updateIntent(id: string, patch: IntentPatch): Promise<void>;
  mine(tgId: bigint, chatId: bigint): Promise<MineRow[]>;
  /** a one-time token for the /link flow; only its hash is stored */
  createLinkRequest(tgId: bigint, nowMs: number): Promise<{ token: string }>;
}

export function drizzleBotStore(db: Db): BotStore {
  return {
    async getUser(tgId) {
      const [u] = await db.select({ tz: tgUsers.tz, tzOffsetMin: tgUsers.tzOffsetMin }).from(tgUsers).where(eq(tgUsers.tgId, tgId));
      return u;
    },
    async upsertUser(tgId, patch) {
      const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      await db
        .insert(tgUsers)
        .values({ tgId, ...patch })
        .onConflictDoUpdate({ target: tgUsers.tgId, set: Object.keys(set).length ? set : { tgId } });
    },
    async createIntent(row) {
      const [it] = await db.insert(intents).values(row).returning({ id: intents.id });
      return { id: it!.id };
    },
    async getIntent(id) {
      const [it] = await db
        .select({ id: intents.id, tgId: intents.tgId, text: intents.text, draft: intents.draft, expiresAt: intents.expiresAt })
        .from(intents)
        .where(eq(intents.id, id));
      return it;
    },
    async updateIntent(id, patch) {
      await db.update(intents).set(patch).where(eq(intents.id, id));
    },
    async createLinkRequest(tgId, nowMs) {
      const token = newLinkToken();
      await db.insert(linkRequests).values({ tokenHash: tokenHash(token), tgId, expiresAt: new Date(nowMs + LINK_TOKEN_TTL_SEC * 1000) });
      return { token };
    },
    async mine(tgId, chatId) {
      const ws = await db.select({ id: watchers.escrowId }).from(watchers).where(eq(watchers.tgChatId, chatId));
      const mine = await db
        .select({ id: intents.escrowId })
        .from(intents)
        .where(and(isNotNull(intents.escrowId), or(eq(intents.tgChatId, chatId), eq(intents.tgId, tgId))));
      const ids = [...new Set([...ws.map((w) => w.id), ...mine.map((m) => m.id!)])];
      if (!ids.length) return [];
      return db
        .select({ amount: escrows.amount, status: escrows.status, expiry: escrows.expiry })
        .from(escrows)
        .where(inArray(escrows.id, ids))
        .orderBy(desc(escrows.createdBlock))
        .limit(10);
    },
  };
}
