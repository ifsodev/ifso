// The bot's command flow, free of Telegram types: text in, a reply (text + buttons) out. Never guesses:
// anything unclear becomes a question with buttons. Buttons are only URL buttons (to the web app) or callback
// buttons (answers to our own questions); there is no Mini App and no wallet inside Telegram.
import { copy } from "../core/copy";
import { formatUsdg } from "../core/money";
import { parseCommand, replaceCI, type ParseResult, type Question } from "../core/parser";
import { Status } from "../core/types";
import { canonicalZone, formatWhen, offsetLabel, zoneOffsetAt, zoneOffsetFor, type Zone } from "../core/tz";
import type { FixtureMatch } from "../api/fixtures";
import type { BotStore } from "./store";

export type Button = { text: string; url: string } | { text: string; data: string };
export interface Reply {
  text: string;
  /** rows of buttons */
  buttons?: Button[][];
}

export type FixtureLookup = (team: string, opponent?: string, on?: number) => Promise<FixtureMatch[] | undefined>;

export interface FlowEnv {
  store: BotStore;
  publicAppUrl: string;
  tickers: ReadonlySet<string>;
  fixtures?: FixtureLookup;
  now?: () => number;
}

const nowOf = (e: FlowEnv) => (e.now ?? Date.now)();
const questionButtons = (q: Question, intentId: string): Button[][] => q.options.map((o, i) => [{ text: o.label, data: `q:${intentId}:${i}` }]);

type Evaluated =
  | { t: "error"; text: string }
  | { t: "question"; q: Question; r: ParseResult }
  | { t: "ready"; r: ParseResult; text: string; extra: string[] };

async function evaluate(e: FlowEnv, text: string, user: { tz: string | null; tzOffsetMin: number } | undefined): Promise<Evaluated> {
  const r = parseCommand(text, { nowMs: nowOf(e), tz: user?.tz ?? undefined, tzOffsetMin: user?.tzOffsetMin ?? 0, tickers: e.tickers });
  if (r.errors.length) return { t: "error", text: r.errors.join("\n") };
  if (r.questions[0]) return { t: "question", q: r.questions[0], r };
  if (r.ambiguities.length) return { t: "error", text: r.ambiguities.join("\n") };
  if (!r.ok || !r.condition) return { t: "error", text: copy.parse.usage };

  const extra: string[] = [];
  const c = r.condition;
  if (c.kind === "SPORTS" && e.fixtures) {
    const found = await e.fixtures(c.team, c.opponent, c.on).catch(() => undefined);
    if (found) {
      if (!found.length) return { t: "error", text: copy.bot.noFixture(c.team) };
      const byTeam = new Map<string, FixtureMatch>();
      for (const f of found) if (!byTeam.has(f.matched)) byTeam.set(f.matched, f);
      if (byTeam.size > 1) {
        const zone = r.zone;
        const q: Question = {
          kind: "team",
          text: copy.bot.askTeam(c.team),
          options: [...byTeam.values()].slice(0, 6).map((f) => ({
            label: copy.bot.teamOption(f.matched, f.league, formatWhen(f.commence, zone)),
            text: replaceCI(text, c.team, f.matched),
          })),
        };
        return { t: "question", q, r };
      }
      const f = found[0]!;
      extra.push(copy.bot.fixtureFound(f.home, f.away, f.league, formatWhen(f.commence, r.zone)));
    }
  }
  return { t: "ready", r, text, extra };
}

function instantOf(r: ParseResult, nowMs: number): number {
  const c = r.condition;
  if (c?.kind === "TIME") return c.at * 1000;
  if (c?.kind === "PRICE") return c.deadline * 1000;
  if (c?.kind === "SPORTS" && c.on) return c.on * 1000;
  return nowMs;
}

async function present(e: FlowEnv, ev: Evaluated, ctx: { intentId?: string; tgId: bigint; chatId: bigint; text: string; user?: { tz: string | null; tzOffsetMin: number } }): Promise<Reply> {
  if (ev.t === "error") return { text: ev.text };
  const handle = ev.r.recipient?.type === "handle" ? ev.r.recipient.handle : null;
  const zone: Zone | undefined = ctx.user?.tz ? { name: ctx.user.tz } : ctx.user?.tzOffsetMin ? { offsetMin: ctx.user.tzOffsetMin } : undefined;
  const offset = zoneOffsetFor(zone, instantOf(ev.r, nowOf(e)));

  if (ev.t === "question") {
    const draft = { pending: { kind: ev.q.kind, options: ev.q.options.map((o) => ({ label: o.label, text: o.text })) } };
    const id = ctx.intentId
      ? (await e.store.updateIntent(ctx.intentId, { draft, recipientHandle: handle }), ctx.intentId)
      : (await e.store.createIntent({ tgId: ctx.tgId, tgChatId: ctx.chatId, text: ctx.text, draft, recipientHandle: handle, tzOffsetMin: offset })).id;
    return { text: ev.q.text, buttons: questionButtons(ev.q, id) };
  }

  const patch = { text: ev.text, draft: ev.r.condition, recipientHandle: handle, tzOffsetMin: offset };
  const id = ctx.intentId
    ? (await e.store.updateIntent(ctx.intentId, patch), ctx.intentId)
    : (await e.store.createIntent({ tgId: ctx.tgId, tgChatId: ctx.chatId, ...patch, text: ev.text })).id;
  const notes = [...ev.r.notes, ...ev.extra];
  const body = `${ev.r.preview}${notes.length ? `\n\n${notes.map((n) => `• ${n}`).join("\n")}` : ""}`;
  return { text: body, buttons: [[{ text: copy.bot.confirmButton, url: `${e.publicAppUrl}/new/${id}` }]] };
}

/** `/ifso ...` and `/challenge ...`. `body` is everything after the command word. */
export async function handleCommand(e: FlowEnv, a: { tgId: bigint; chatId: bigint; username?: string | null; cmd: "ifso" | "challenge"; body: string }): Promise<Reply> {
  const user = await e.store.getUser(a.tgId);
  const text = `/${a.cmd} ${a.body}`.trim();
  const ev = await evaluate(e, text, user);
  if (ev.t !== "error") await e.store.upsertUser(a.tgId, { username: a.username ?? null });
  return present(e, ev, { tgId: a.tgId, chatId: a.chatId, text, user });
}

/** A tap on one of our question buttons: `q:<intent id>:<option>`. */
export async function handleAnswer(e: FlowEnv, a: { tgId: bigint; chatId: bigint; intentId: string; option: number }): Promise<{ reply?: Reply; toast?: string }> {
  const it = await e.store.getIntent(a.intentId);
  if (!it || it.expiresAt.getTime() <= nowOf(e)) return { toast: copy.bot.questionExpired };
  if (it.tgId !== a.tgId) return { toast: copy.bot.notYours };
  const pending = (it.draft as { pending?: { options: { label: string; text?: string }[] } } | null)?.pending;
  const picked = pending?.options[a.option];
  if (!pending || !picked?.text) return { toast: copy.bot.questionExpired };
  const user = await e.store.getUser(a.tgId);
  const ev = await evaluate(e, picked.text, user);
  return { reply: await present(e, ev, { intentId: it.id, tgId: a.tgId, chatId: a.chatId, text: picked.text, user }) };
}

export async function handleTz(e: FlowEnv, a: { tgId: bigint; username?: string | null; arg: string }): Promise<Reply> {
  const arg = a.arg.trim();
  const now = nowOf(e);
  if (!arg) {
    const u = await e.store.getUser(a.tgId);
    if (u?.tz) return { text: copy.bot.tzCurrent(`${u.tz} (${offsetLabel(zoneOffsetAt(u.tz, now))} now)`) };
    if (u?.tzOffsetMin) return { text: copy.bot.tzCurrent(offsetLabel(u.tzOffsetMin)) };
    return { text: `${copy.bot.tzNone}\n${copy.bot.tzUsage}` };
  }
  const m = arg.match(/^(?:utc|gmt)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (m) {
    const mins = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
    if (Math.abs(mins) > 14 * 60 || Number(m[3] ?? 0) > 59) return { text: copy.bot.tzBad(arg) };
    await e.store.upsertUser(a.tgId, { username: a.username ?? null, tz: null, tzOffsetMin: mins });
    return { text: copy.bot.tzSet(offsetLabel(mins), offsetLabel(mins)) };
  }
  const zone = canonicalZone(arg);
  if (!zone) return { text: `${copy.bot.tzBad(arg)}\n${copy.bot.tzUsage}` };
  const off = zoneOffsetAt(zone, now);
  await e.store.upsertUser(a.tgId, { username: a.username ?? null, tz: zone, tzOffsetMin: off });
  return { text: copy.bot.tzSet(zone, offsetLabel(off)) };
}

export async function handleMine(e: FlowEnv, a: { tgId: bigint; chatId: bigint }): Promise<Reply> {
  const rows = await e.store.mine(a.tgId, a.chatId);
  if (!rows.length) return { text: copy.bot.nothingYet };
  const lines = rows.map((r) => copy.bot.mineLine(formatUsdg(BigInt(r.amount)), (Status[r.status] ?? "").toLowerCase(), r.expiry.toISOString().slice(0, 10)));
  return { text: lines.join("\n"), buttons: [[{ text: copy.bot.openButton, url: `${e.publicAppUrl}/mine` }]] };
}
