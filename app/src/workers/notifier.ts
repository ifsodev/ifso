// Notifier: turns indexed events into Telegram messages for the people watching an escrow: the sender (the chat
// that created it), the bound recipient and the referee (matched by the address they linked in the bot), plus any
// explicit watcher rows. One message per event per watcher, paced per chat. Uses only copy.ts strings, never
// includes claim links (the bot never sees link secrets) and never logs message text.
import { eq, inArray, sql } from "drizzle-orm";
import { copy } from "../core/copy";
import { formatUsdg } from "../core/money";
import { APPROVE_REFEREE, Kind } from "../core/types";
import { escrows, intents, questions, tgUsers, watchers } from "../db/schema";
import type { Db } from "../db/client";
import type { Deps } from "./deps";

export type Sender = (chatId: bigint, text: string) => Promise<void>;
export type Role = "sender" | "recipient" | "referee";
export interface NotifyEvent {
  name: string;
  escrowId?: string;
  questionId?: string;
  args: Record<string, unknown>;
  txHash?: string;
}
export interface Target {
  chatId: bigint;
  role: Role;
  escrowId: string;
  /** amount in USDG base units, when known */
  amount?: string;
  questionTitle?: string;
}

/** Everything the notifier needs to know about who to tell. */
export interface NotifyStore {
  targets(ev: NotifyEvent): Promise<Target[]>;
}

// ---------------------------------------------------------------- pacing
/** Telegram allows about 1 message a second to one chat and 20 a minute to a group; stay under both. */
export class ChatPacer {
  private last = new Map<string, number[]>();
  constructor(
    private readonly perChatGapMs = 1100,
    private readonly perMinute = 18,
    private readonly now: () => number = Date.now,
  ) {}

  /** ms to wait before the next message to this chat may go out (0 = send now). Reserves the slot. */
  reserve(chat: bigint): number {
    const k = String(chat);
    const t = this.now();
    const sent = (this.last.get(k) ?? []).filter((x) => t - x < 60_000);
    let at = t;
    if (sent.length) at = Math.max(at, sent[sent.length - 1]! + this.perChatGapMs);
    if (sent.length >= this.perMinute) at = Math.max(at, sent[sent.length - this.perMinute]! + 60_000);
    sent.push(at);
    this.last.set(k, sent);
    if (this.last.size > 10_000) this.last.clear();
    return at - t;
  }
}

export interface NotifierOptions {
  store: NotifyStore;
  send: Sender;
  log: Deps["log"];
  pacer?: ChatPacer;
  sleep?: (ms: number) => Promise<void>;
  /** messages that would wait longer than this are dropped, not queued */
  maxWaitMs?: number;
}

export function createNotifier(o: NotifierOptions) {
  const pacer = o.pacer ?? new ChatPacer();
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWait = o.maxWaitMs ?? 20_000;
  const seen = new Set<string>(); // a replayed log never messages twice

  return async function notify(ev: NotifyEvent): Promise<number> {
    if (!ev.escrowId && !ev.questionId) return 0;
    const targets = await o.store.targets(ev);
    let sent = 0;
    const done = new Set<string>();
    for (const t of targets) {
      const text = render(ev.name, t);
      if (!text) continue;
      const key = `${t.escrowId}:${t.chatId}`;
      if (done.has(key)) continue; // one message per event per watcher, even if they hold two roles
      done.add(key);
      const dedupe = ev.txHash ? `${ev.txHash}:${ev.name}:${key}` : undefined;
      if (dedupe && seen.has(dedupe)) continue;
      const wait = pacer.reserve(t.chatId);
      if (wait > maxWait) {
        o.log("telegram send skipped: chat rate limit", { chat: String(t.chatId), event: ev.name });
        continue;
      }
      if (wait > 0) await sleep(wait);
      try {
        await o.send(t.chatId, text);
        sent++;
        if (dedupe) seen.add(dedupe);
        if (seen.size > 20_000) seen.clear();
      } catch (e) {
        o.log("telegram send failed", { chat: String(t.chatId), event: ev.name, err: String((e as Error)?.name ?? "error") });
      }
    }
    return sent;
  };
}

// ---------------------------------------------------------------- copy
const POSTED = ["unknown", "yes", "no"];

export function render(name: string, t: Pick<Target, "role" | "amount" | "questionTitle"> & { args?: Record<string, unknown> }, args: Record<string, unknown> = t.args ?? {}): string | undefined {
  const amt = (k: string) => formatUsdg(BigInt(String(args[k] ?? t.amount ?? 0)));
  const total = () => formatUsdg(BigInt(String(args.amount ?? t.amount ?? 0)));
  const q = t.questionTitle ?? "your question";
  switch (name) {
    case "Created":
      return t.role === "sender" ? copy.bot.created(total()) : t.role === "referee" ? copy.bot.refereeAsked(total()) : copy.bot.incoming(total());
    case "Claimed":
      return copy.bot.claimed(total());
    case "Accepted":
      return copy.bot.accepted;
    case "Met":
      return copy.bot.met;
    case "Released":
      return copy.bot.released(amt("amount"), shortAddr(String(args.to)));
    case "Returned":
      return copy.bot.returned(amt("amount"));
    case "Voided":
      return copy.bot.voided;
    case "Proposed":
      return copy.bot.resolverPosted(q, POSTED[Number(args.outcome)] ?? String(args.outcome));
    case "Disputed":
      return copy.bot.disputed(q);
    default:
      return undefined;
  }
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// ---------------------------------------------------------------- who to tell (Postgres)
export function drizzleNotifyStore(db: Db): NotifyStore {
  return {
    async targets(ev) {
      const ids = new Set<string>();
      const titles = new Map<string, string>();
      if (ev.escrowId) ids.add(ev.escrowId);
      if (ev.questionId) {
        // resolver events: tell everyone watching an escrow that waits on this question
        const [qrow] = await db.select({ title: questions.title }).from(questions).where(eq(questions.id, ev.questionId));
        for (const e of await db.select({ id: escrows.id }).from(escrows).where(eq(escrows.questionId, ev.questionId))) {
          ids.add(e.id);
          if (qrow) titles.set(e.id, qrow.title);
        }
      }
      if (!ids.size) return [];
      const list = [...ids];
      const rows = await db.select().from(escrows).where(inArray(escrows.id, list));
      const out: Target[] = [];
      const withInfo = (id: string, chatId: bigint, role: Role): Target => {
        const e = rows.find((r) => r.id === id);
        return { chatId, role, escrowId: id, amount: e ? String(e.amount) : undefined, questionTitle: titles.get(id) };
      };

      for (const w of await db.select().from(watchers).where(inArray(watchers.escrowId, list))) out.push(withInfo(w.escrowId, w.tgChatId, w.role));
      for (const i of await db.select({ id: intents.escrowId, chat: intents.tgChatId }).from(intents).where(inArray(intents.escrowId, list)))
        if (i.id && i.chat !== null) out.push(withInfo(i.id, i.chat, "sender"));

      // linked addresses: sender, bound recipient, referee
      const byAddr = new Map<string, { id: string; role: Role }[]>();
      for (const e of rows) {
        const add = (a: string | null | undefined, role: Role) => a && byAddr.set(a.toLowerCase(), [...(byAddr.get(a.toLowerCase()) ?? []), { id: e.id, role }]);
        add(e.sender, "sender");
        add(e.recipient, "recipient");
        const c = e.condition as { kind?: number | string; mode?: number | string; target?: string } | null;
        if (Number(c?.kind) === Kind.APPROVE && Number(c?.mode) === APPROVE_REFEREE) add(c?.target, "referee");
      }
      if (byAddr.size) {
        const users = await db
          .select({ tgId: tgUsers.tgId, address: tgUsers.address })
          .from(tgUsers)
          .where(inArray(sql`lower(${tgUsers.address})`, [...byAddr.keys()]));
        for (const u of users) for (const m of byAddr.get(u.address!.toLowerCase()) ?? []) out.push(withInfo(m.id, u.tgId, m.role));
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- production entry (used by the notify queue worker)
let shared: { send: Sender; run: ReturnType<typeof createNotifier> } | undefined;
export async function notifyEvent(deps: Deps, send: Sender, ev: NotifyEvent) {
  if (!shared || shared.send !== send) shared = { send, run: createNotifier({ store: drizzleNotifyStore(deps.db), send, log: deps.log }) };
  await shared.run(ev);
}
