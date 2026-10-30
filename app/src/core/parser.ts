// Telegram / web command parser: "/ifso @jake 20 if arsenal win" -> a condition draft + preview.
// Pure and deterministic (clock and timezone are inputs). Never guesses on ambiguity: anything uncertain
// lands in `ambiguities`, and the bot asks before building a payment.
import { nyWallClockToUnix } from "./price";
import { copy } from "./copy";
import { DEFAULTS } from "./builder";
import { formatWhen, zoneOffsetFor, zonedWallToUnix, type Zone } from "./tz";

export type Recipient =
  | { type: "handle"; handle: string }
  | { type: "address"; address: `0x${string}` }
  | { type: "link" };

export type ConditionDraft =
  | { kind: "TIME"; at: number }
  | {
      kind: "PRICE";
      ticker: string;
      op: "GTE" | "LTE";
      priceUsd: string;
      mode: "AT_DEADLINE" | "TOUCH";
      deadline: number;
    }
  | { kind: "SPORTS"; team: string; opponent?: string; result: "WIN" | "DRAW" | "WIN_OR_DRAW" | "LOSE"; on?: number }
  | { kind: "MARKET"; venue: "polymarket" | "hyperliquid"; ref: string; answer: "YES" | "NO" }
  | { kind: "APPROVE"; mode: "PARTIES" }
  | { kind: "APPROVE"; mode: "REFEREE"; referee: Recipient };

export interface ParseContext {
  nowMs: number;
  /** user's UTC offset in minutes for TIME conditions (e.g. Dubai = 240). Stock deadlines always use New York time. */
  tzOffsetMin?: number;
  /** user's IANA zone (e.g. "Asia/Dubai"); wins over tzOffsetMin and follows daylight saving */
  tz?: string;
  /** tickers with a registered price feed (upper-case) */
  tickers: ReadonlySet<string>;
  /** optional last prices (8-dec feed units, underlying terms) to infer the direction of "hits 200" */
  lastPrice?: Readonly<Record<string, number>>;
}

/** A question the bot asks instead of guessing. Each option carries the full command text to run if it is picked. */
export interface Question {
  kind: "direction" | "date_format" | "deadline" | "weekend" | "team" | "touch_challenge";
  text: string;
  options: { label: string; text?: string; replace?: [from: string, to: string] }[];
}

export interface ParseResult {
  ok: boolean;
  twoSided: boolean;
  recipient?: Recipient;
  amountUsdg?: string;
  counterAmountUsdg?: string;
  condition?: ConditionDraft;
  ambiguities: string[];
  /** structured form of `ambiguities` (same order); the bot turns these into buttons */
  questions: Question[];
  notes: string[];
  errors: string[];
  preview?: string;
  /** zone used for the deadline text in the preview */
  zone?: Zone;
  /** flat fee in USDG shown in the preview */
  feeUsdg?: string;
  /** unix seconds the escrow would expire at, when it can be known before a fixture is chosen */
  expiry?: number;
}

/** Records an ambiguity both as a plain sentence (web) and as a question with buttons (bot). */
function ask(res: Pick<ParseResult, "ambiguities"> & { questions?: Question[] }, q: Question) {
  res.ambiguities.push(q.text);
  res.questions?.push(q);
}

const AMOUNT = String.raw`\$?(\d{1,7}(?:\.\d{1,6})?)\s*(?:usdg|usd|dollars?|bucks|\$)?`;
const HEAD = new RegExp(
  String.raw`^(?:\/(ifso|challenge)(?:@[a-z0-9_]+)?\s+)?(@[a-z0-9_]{3,32}|0x[0-9a-f]{40}|link)\s+` +
    AMOUNT +
    String.raw`(?:\s*(?:vs|\/)\s*` +
    AMOUNT +
    String.raw`)?\s+(if|when|on|at|in|once)\s+(.+)$`,
  "i",
);

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function parseCommand(input: string, ctx: ParseContext): ParseResult {
  const res: ParseResult = { ok: false, twoSided: false, ambiguities: [], questions: [], notes: [], errors: [] };
  res.zone = ctx.tz ? { name: ctx.tz } : ctx.tzOffsetMin ? { offsetMin: ctx.tzOffsetMin } : undefined;
  const text = input.trim().replace(/\s+/g, " ").replace(/[’‘]/g, "'");
  const m = text.match(HEAD);
  if (!m) {
    res.errors.push(copy.parse.usage);
    return res;
  }
  const [, cmd, to, amt, amt2, conn, rest] = m;
  res.twoSided = (cmd ?? "").toLowerCase() === "challenge";
  res.recipient = parseRecipient(to!);
  res.amountUsdg = normAmount(amt!);
  if (res.twoSided) res.counterAmountUsdg = normAmount(amt2 ?? amt!);
  else if (amt2) res.errors.push(copy.parse.counterOnlyForChallenges);
  if (Number(res.amountUsdg) < 1) res.errors.push(copy.parse.minAmount);

  const condText = rest!.replace(/[.!?]+$/, "").trim();
  const connective = conn!.toLowerCase();
  res.condition = parseCondition(condText, connective, ctx, res);

  if (res.condition && res.twoSided) {
    if (res.condition.kind === "TIME") res.errors.push(copy.parse.challengeNeedsOutcome);
    if (res.condition.kind === "APPROVE" && res.condition.mode === "PARTIES") res.errors.push(copy.parse.challengeNeedsReferee);
    // The contract refuses a challenge on "touches": it can never end in a loss for the sender, and the other side
    // could accept after the price already crossed. Offer the two honest alternatives instead of a dead end.
    if (res.condition.kind === "PRICE" && res.condition.mode === "TOUCH") {
      const verb = condText.toLowerCase().match(/\b(hits|touches|reaches|tops|breaks|crosses|gets)\b/)?.[1];
      const asIfso = text.replace(/^\/challenge(@[a-z0-9_]+)?/i, "/ifso").replace(/(\$?\d[\d.]*\s*(?:usdg|usd|dollars?|bucks|\$)?)\s*(?:vs|\/)\s*\$?\d[\d.]*\s*(?:usdg|usd|dollars?|bucks|\$)?/i, "$1");
      ask(res, {
        kind: "touch_challenge",
        text: copy.parse.touchChallenge,
        options: [
          { label: copy.parse.optCheckAtDeadline, replace: verb ? [verb, "is"] : undefined },
          { label: copy.parse.optSendAsIfso, text: asIfso },
        ],
      });
    }
    if (res.recipient?.type === "link") res.notes.push(copy.parse.challengeLinkPrivate);
  }
  if (res.condition && "deadline" in res.condition && res.condition.deadline > 0 && res.condition.deadline * 1000 <= ctx.nowMs) {
    res.errors.push(copy.parse.inPast);
  }
  if (res.condition?.kind === "TIME" && res.condition.at * 1000 <= ctx.nowMs) res.errors.push(copy.parse.inPast);

  for (const q of res.questions)
    for (const o of q.options) {
      if (o.replace) o.text = replaceCI(text, o.replace[0], o.replace[1]);
      delete o.replace;
    }
  if (res.condition) {
    res.feeUsdg = res.condition.kind === "SPORTS" || res.condition.kind === "MARKET" ? "0.75" : "0.25";
    res.expiry = expiryFor(res.condition, Math.floor(ctx.nowMs / 1000));
  }
  res.ok = !!res.condition && res.errors.length === 0 && res.ambiguities.length === 0;
  if (res.condition) res.preview = renderPreview(res);
  return res;
}

/** Same windows the builder uses; undefined when the expiry depends on a fixture or market not chosen yet. */
export function expiryFor(c: ConditionDraft, nowSec: number): number | undefined {
  switch (c.kind) {
    case "TIME":
      return c.at + DEFAULTS.timeClaimWindow;
    case "PRICE":
      return c.mode === "TOUCH" ? c.deadline + DEFAULTS.touchGrace : c.deadline + DEFAULTS.holdWindow + DEFAULTS.priceSettleWindow;
    case "APPROVE":
      return nowSec + DEFAULTS.approveWindow;
    default:
      return undefined;
  }
}

/** Replaces the first case-insensitive occurrence; falls back to the whole text when `from` is not found. */
export function replaceCI(text: string, from: string, to: string): string {
  const i = text.toLowerCase().indexOf(from.toLowerCase());
  return i < 0 ? text : text.slice(0, i) + to + text.slice(i + from.length);
}

function parseRecipient(s: string): Recipient {
  if (/^link$/i.test(s)) return { type: "link" };
  if (s.startsWith("@")) return { type: "handle", handle: s.slice(1).toLowerCase() };
  return { type: "address", address: s.toLowerCase() as `0x${string}` };
}

function normAmount(s: string): string {
  const [w, f = ""] = s.split(".");
  const frac = f.replace(/0+$/, "");
  return frac ? `${BigInt(w!)}.${frac}` : `${BigInt(w!)}`;
}

function parseCondition(t: string, conn: string, ctx: ParseContext, res: ParseResult): ConditionDraft | undefined {
  const lower = t.toLowerCase();

  // ---- TIME: "on nov 1", "on the 1st", "in 3 days", "at 9am friday"
  if (conn === "on" || conn === "at" || conn === "in") {
    const when = parseWhen(`${conn === "in" ? "in " : ""}${lower}`, ctx.nowMs, ctx.tzOffsetMin ?? 0, 9, res, false, ctx.tz);
    if (when === undefined) {
      if (!res.ambiguities.length) res.errors.push(copy.parse.badDate(t));
      return undefined;
    }
    return { kind: "TIME", at: when };
  }

  // ---- APPROVE
  if (/^(i|we|we both|both of us|both)\s+(say|tap|approve|confirm|agree)(\s+(ok|okay|so|yes))?$/.test(lower) || /^(i approve|both ok|we both ok)$/.test(lower)) {
    return { kind: "APPROVE", mode: "PARTIES" };
  }
  const ref = lower.match(/^(@[a-z0-9_]{3,32}|0x[0-9a-f]{40})\s+(says so|says ok|approves|decides|confirms|agrees)$/) ?? lower.match(/^referee\s+(@[a-z0-9_]{3,32}|0x[0-9a-f]{40})(\s+decides)?$/);
  if (ref) return { kind: "APPROVE", mode: "REFEREE", referee: parseRecipient(ref[1]!) };

  // ---- MARKET: "polymarket <slug|url> resolves yes", "hl 1234 yes"
  const mk = lower.match(/^(polymarket|poly|pm|hyperliquid|hl)\s+(\S+)\s+(?:resolves\s+|is\s+|settles\s+)?(yes|no)$/) ??
    lower.match(/^(https?:\/\/(?:www\.)?polymarket\.com\/\S+)\s+(?:resolves\s+)?(yes|no)$/);
  if (mk) {
    if (mk.length === 4) {
      const venue = /^(hyperliquid|hl)$/.test(mk[1]!) ? "hyperliquid" : "polymarket";
      return { kind: "MARKET", venue, ref: mk[2]!, answer: mk[3]!.toUpperCase() as "YES" | "NO" };
    }
    return { kind: "MARKET", venue: "polymarket", ref: mk[1]!, answer: mk[2]!.toUpperCase() as "YES" | "NO" };
  }

  // ---- PRICE
  const pm = lower.match(
    /^\$?([a-z]{1,6})\s+(?:(closes|close|ends|finishes|settles|is|trades|stays|hits|touches|reaches|tops|breaks|crosses|goes|gets)\s+)?(?:(at or above|at or below|above|over|below|under|>=|<=|>|<)\s+)?\$?(\d{1,7}(?:\.\d{1,8})?)(?:\s+(by|on|at|before|this|next)\s+(.+))?$/,
  );
  if (pm && ctx.tickers.has(pm[1]!.toUpperCase())) {
    const ticker = pm[1]!.toUpperCase();
    const verb = pm[2] ?? "";
    const dirWord = pm[3] ?? "";
    const price = pm[4]!;
    const touch = /^(hits|touches|reaches|tops|breaks|crosses|gets)$/.test(verb);
    let op: "GTE" | "LTE" | undefined;
    if (/^(at or above|above|over|>=|>)$/.test(dirWord) || verb === "tops") op = "GTE";
    else if (/^(at or below|below|under|<=|<)$/.test(dirWord)) op = "LTE";
    else if (touch && ctx.lastPrice?.[ticker] !== undefined) {
      op = ctx.lastPrice[ticker]! < Number(price) ? "GTE" : "LTE";
      res.notes.push(copy.parse.inferredDirection(ticker, op));
    }
    if (dirWord === ">" || dirWord === "<") res.notes.push(copy.parse.inclusive);
    const rest = pm[5] ? ` ${pm[5]} ${pm[6]}` : "";
    const lead = `${pm[1]} ${verb ? verb + " " : ""}`;
    if (!op)
      ask(res, {
        kind: "direction",
        text: copy.parse.needDirection(ticker, price),
        options: [
          { label: copy.parse.optAbove(price), replace: [t, `${lead}at or above ${price}${rest}`] },
          { label: copy.parse.optBelow(price), replace: [t, `${lead}at or below ${price}${rest}`] },
        ],
      });
    if (!verb || verb === "is" || verb === "trades" || verb === "stays") res.notes.push(copy.parse.atDeadlineMeaning);

    const prepWhen = pm[5] ? `${pm[5] === "this" || pm[5] === "next" ? pm[5] + " " : ""}${pm[6]}` : undefined;
    let deadline: number | undefined;
    if (!prepWhen)
      ask(res, {
        kind: "deadline",
        text: copy.parse.needDeadline,
        options: [
          { label: copy.parse.optTomorrow, replace: [t, `${t} by tomorrow`] },
          { label: copy.parse.optFriday, replace: [t, `${t} by friday`] },
          { label: copy.parse.optNextFriday, replace: [t, `${t} by next friday`] },
        ],
      });
    else {
      deadline = parseWhen(prepWhen, ctx.nowMs, 0, touch ? 20 : 16, res, true, ctx.tz);
      if (deadline === undefined && !res.ambiguities.length) res.errors.push(copy.parse.badDate(prepWhen));
    }
    return {
      kind: "PRICE",
      ticker,
      op: op ?? "GTE",
      priceUsd: price,
      mode: touch ? "TOUCH" : "AT_DEADLINE",
      deadline: deadline ?? 0,
    };
  }
  if (pm && !ctx.tickers.has(pm[1]!.toUpperCase()) && /^[a-z]{1,5}$/.test(pm[1]!) && pm[3]) {
    res.errors.push(copy.parse.unknownTicker(pm[1]!.toUpperCase()));
    return undefined;
  }

  // ---- SPORTS: "arsenal win", "arsenal beat chelsea", "arsenal win or draw on saturday", "arsenal don't lose"
  const sp = lower.match(
    /^(?:the\s+)?([a-z][a-z0-9 .'&-]{1,40}?)\s+(win or draw|don't lose|do not lose|dont lose|wins?|beats?|draws?|loses?|lose)(?:\s+(?:vs\.?|v|against|over|to|with)?\s*([a-z][a-z0-9 .'&-]{1,40}?))?(?:\s+(?:on|this|next)\s+(.+))?$/,
  );
  if (sp) {
    const team = sp[1]!.trim();
    const v = sp[2]!;
    let opp = sp[3]?.trim();
    let on: number | undefined;
    // "arsenal win saturday" -> trailing word is a date, not an opponent
    if (opp && sp[4] === undefined && parseWhen(opp, ctx.nowMs, ctx.tzOffsetMin ?? 0, 12, { ambiguities: [], questions: [], notes: [] }, false, ctx.tz) !== undefined) {
      on = parseWhen(opp, ctx.nowMs, ctx.tzOffsetMin ?? 0, 12, res, false, ctx.tz);
      opp = undefined;
    }
    if (sp[4]) on = parseWhen(sp[4], ctx.nowMs, ctx.tzOffsetMin ?? 0, 12, res, false, ctx.tz);
    const result = /^(win or draw|don't lose|do not lose|dont lose)$/.test(v)
      ? "WIN_OR_DRAW"
      : /^draws?$/.test(v)
        ? "DRAW"
        : /^(loses?|lose)$/.test(v)
          ? "LOSE"
          : "WIN";
    res.notes.push(copy.parse.sportsRules);
    if (!opp && !on) res.notes.push(copy.parse.nextFixture(team));
    return { kind: "SPORTS", team, opponent: opp, result, on };
  }

  res.errors.push(copy.parse.unknownCondition(t));
  return undefined;
}

/**
 * Parses a date/time phrase. Returns unix seconds or undefined.
 * stockClock=true: interpret in New York time (market close default hour), weekend deadlines roll to Friday.
 */
export function parseWhen(
  phrase: string,
  nowMs: number,
  tzOffsetMin: number,
  defaultHour: number,
  res: Pick<ParseResult, "ambiguities" | "notes"> & { questions?: Question[] },
  stockClock = false,
  tzName?: string,
): number | undefined {
  let p = phrase.toLowerCase().trim().replace(/^(by|on|at|before)\s+/, "");
  let hour = defaultHour;
  let minute = 0;
  let explicitTime = false;
  const tm = p.match(/(?:^|\s)(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*(et|est|edt|utc))?$/);
  if (tm && (tm[3] || tm[2] || tm[4])) {
    let h = Number(tm[1]);
    if (tm[3] === "pm" && h < 12) h += 12;
    if (tm[3] === "am" && h === 12) h = 0;
    if (h > 23 || Number(tm[2] ?? 0) > 59) return undefined;
    hour = h;
    minute = Number(tm[2] ?? 0);
    explicitTime = true;
    p = p.slice(0, tm.index).trim();
  }
  if (p === "noon") {
    hour = 12;
    p = "today";
  }

  // local calendar "today" in the relevant clock
  const offMin = stockClock ? nyOffsetMinutes(nowMs) : tzName ? zoneOffsetFor({ name: tzName }, nowMs) : tzOffsetMin;
  const wallToUnix = (yy: number, mm: number, dd: number, h: number, mi: number, off: number) =>
    tzName && !stockClock ? zonedWallToUnix(tzName, yy, mm, dd, h, mi) : wallToUnixFixed(yy, mm, dd, h, mi, off);
  const localNow = new Date(nowMs + offMin * 60_000);
  let y = localNow.getUTCFullYear();
  let mo = localNow.getUTCMonth();
  let d = localNow.getUTCDate();
  const dow = localNow.getUTCDay();

  const rel = p.match(/^in\s+(\d{1,3})\s+(minutes?|mins?|hours?|hrs?|days?|weeks?)$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!;
    const sec = /^min/.test(unit) ? 60 : /^h/.test(unit) ? 3600 : /^d/.test(unit) ? 86400 : 604800;
    return Math.floor(nowMs / 1000) + n * sec;
  }

  let matched = false;
  if (p === "" && explicitTime) {
    matched = true; // "at 5pm" = today
  } else if (p === "today" || p === "tonight" || p === "end of day" || p === "eod" || p === "the close" || p === "close") {
    matched = true;
    if (p === "tonight" && !explicitTime) hour = 21;
  } else if (p === "tomorrow") {
    matched = true;
    d += 1;
  } else {
    const wd = p.match(/^(this\s+|next\s+)?([a-z]+)$/);
    const wdIdx = wd ? Math.max(WEEKDAYS.indexOf(wd[2]!), WEEKDAY_SHORT.indexOf(wd[2]!)) : -1;
    if (wd && wdIdx >= 0) {
      matched = true;
      let delta = (wdIdx - dow + 7) % 7;
      if (wd[1]?.startsWith("next")) delta = delta === 0 ? 7 : delta + 7;
      if (delta === 0) {
        const todayTarget = wallToUnix(y, mo, d, hour, minute, offMin);
        if (todayTarget * 1000 <= nowMs) delta = 7;
      }
      d += delta;
    }
    const dom = p.match(/^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)$/);
    if (!matched && dom) {
      matched = true;
      const day = Number(dom[1]);
      if (day < 1 || day > 31) return undefined;
      if (wallToUnix(y, mo, day, hour, minute, offMin) * 1000 <= nowMs) mo += 1;
      d = day;
      res.notes.push(`"${p}" = ${MONTHS[((mo % 12) + 12) % 12]} ${day}`);
    }
    const md = p.match(/^([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/) ?? p.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})(?:\s+(\d{4}))?$/);
    if (!matched && md) {
      const monthWord = /^\d/.test(md[1]!) ? md[2]! : md[1]!;
      const dayNum = Number(/^\d/.test(md[1]!) ? md[1] : md[2]);
      const mIdx = MONTHS.findIndex((x) => x.startsWith(monthWord.slice(0, 3)));
      if (mIdx >= 0 && dayNum >= 1 && dayNum <= 31) {
        matched = true;
        mo = mIdx;
        d = dayNum;
        if (md[3]) y = Number(md[3]);
        else if (wallToUnix(y, mo, d, hour, minute, offMin) * 1000 <= nowMs) y += 1;
      }
    }
    const iso = p.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!matched && iso) {
      matched = true;
      y = Number(iso[1]);
      mo = Number(iso[2]) - 1;
      d = Number(iso[3]);
    }
    const slash = p.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (!matched && slash) {
      const a = Number(slash[1]);
      const b = Number(slash[2]);
      const yr = slash[3] ? (slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3])) : undefined;
      const dayFirst = a > 12 || a === b ? true : b > 12 ? false : undefined;
      if (dayFirst === undefined) {
        const word = (m: number) => MONTHS[m - 1]!.slice(0, 3);
        ask(res, {
          kind: "date_format",
          text: copy.parse.askDateFormat(slash[0]),
          options: [
            { label: copy.parse.optDayFirst(a, word(b)), replace: [slash[0], `${a} ${word(b)}${yr ? " " + yr : ""}`] },
            { label: copy.parse.optMonthFirst(b, word(a)), replace: [slash[0], `${word(a)} ${b}${yr ? " " + yr : ""}`] },
          ],
        });
        return undefined;
      }
      const [dd, mm] = dayFirst ? [a, b] : [b, a];
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return undefined;
      matched = true;
      mo = mm - 1;
      d = dd;
      if (yr) y = yr;
      else if (wallToUnix(y, mo, d, hour, minute, offMin) * 1000 <= nowMs) y += 1;
    }
  }
  if (!matched) return undefined;

  let unix = wallToUnix(y, mo, d, hour, minute, offMin);
  if (stockClock) {
    // recompute with the DST offset of the target day, and roll weekends back to Friday's close
    const target = new Date(Date.UTC(y, mo, d));
    let dd = target.getUTCDate();
    const wday = target.getUTCDay();
    if (wday === 6 || wday === 0) {
      const ymd = (t: Date) => `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
      const fri = new Date(Date.UTC(y, mo, d - (wday === 6 ? 1 : 2)));
      const mon = new Date(Date.UTC(y, mo, d + (wday === 6 ? 2 : 1)));
      dd -= wday === 6 ? 1 : 2;
      res.notes.push(copy.parse.weekendRolled);
      ask(res, {
        kind: "weekend",
        text: copy.parse.askWeekend,
        options: [
          { label: copy.parse.optFridayClose, replace: [p, ymd(fri)] },
          { label: copy.parse.optMondayClose, replace: [p, ymd(mon)] },
        ],
      });
    }
    unix = nyWallClockToUnix(target.getUTCFullYear(), target.getUTCMonth() + 1, dd, hour, minute);
  }
  return unix;
}

function wallToUnixFixed(y: number, mo: number, d: number, h: number, mi: number, offMin: number): number {
  return Math.floor((Date.UTC(y, mo, d, h, mi) - offMin * 60_000) / 1000);
}

function nyOffsetMinutes(nowMs: number): number {
  // reuse the DST rule from price.ts by probing a wall clock conversion
  const d = new Date(nowMs);
  const noonUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  const unix = nyWallClockToUnix(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 12);
  return Math.round((noonUtc / 1000 - unix) / 60);
}

// ---------------------------------------------------------------- preview
export function renderPreview(r: ParseResult): string {
  const who = r.recipient?.type === "handle" ? `@${r.recipient.handle}` : r.recipient?.type === "address" ? short(r.recipient.address) : copy.preview.linkHolder;
  const c = r.condition!;
  const cond = describeCondition(c, r.zone);
  const lines = [r.twoSided ? copy.preview.challenge(who, r.amountUsdg!, r.counterAmountUsdg!, cond) : copy.preview.payment(who, r.amountUsdg!, cond)];
  if (r.feeUsdg) lines.push(copy.preview.fee(r.feeUsdg));
  lines.push(r.expiry ? copy.preview.expiry(formatWhen(r.expiry, r.zone)) : copy.preview.expiryAfterResult);
  if (c.kind === "PRICE") lines.push(copy.preview.priceBand);
  return lines.join("\n");
}

export function describeCondition(c: ConditionDraft, zone?: Zone): string {
  switch (c.kind) {
    case "TIME":
      return copy.describe.time(fmtDate(c.at, zone));
    case "PRICE":
      return copy.describe.price(c.ticker, c.op, c.priceUsd, c.mode, fmtDate(c.deadline, zone));
    case "SPORTS":
      return copy.describe.sports(c.team, c.result, c.opponent, c.on ? fmtDate(c.on, zone) : undefined);
    case "MARKET":
      return copy.describe.market(c.venue, c.ref, c.answer);
    case "APPROVE":
      return c.mode === "PARTIES" ? copy.describe.parties : copy.describe.referee(c.referee.type === "handle" ? `@${c.referee.handle}` : c.referee.type === "address" ? short(c.referee.address) : "?");
  }
}

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function fmtDate(unix: number, zone?: Zone): string {
  return formatWhen(unix, zone);
}
