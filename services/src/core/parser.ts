// Telegram / web command parser: "/ifso @jake 20 if arsenal win" -> a condition draft + preview.
// Pure and deterministic (clock and timezone are inputs). Never guesses on ambiguity: anything uncertain
// lands in `ambiguities`, and the bot asks before building a payment.
import { nyWallClockToUnix } from "./price";
import { copy } from "./copy";

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
  /** tickers with a registered price feed (upper-case) */
  tickers: ReadonlySet<string>;
  /** optional last prices (8-dec feed units, underlying terms) to infer the direction of "hits 200" */
  lastPrice?: Readonly<Record<string, number>>;
}

export interface ParseResult {
  ok: boolean;
  twoSided: boolean;
  recipient?: Recipient;
  amountUsdg?: string;
  counterAmountUsdg?: string;
  condition?: ConditionDraft;
  ambiguities: string[];
  notes: string[];
  errors: string[];
  preview?: string;
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
  const res: ParseResult = { ok: false, twoSided: false, ambiguities: [], notes: [], errors: [] };
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
    if (res.recipient?.type === "link") res.notes.push(copy.parse.challengeLinkPrivate);
  }
  if (res.condition && "deadline" in res.condition && res.condition.deadline * 1000 <= ctx.nowMs) {
    res.errors.push(copy.parse.inPast);
  }
  if (res.condition?.kind === "TIME" && res.condition.at * 1000 <= ctx.nowMs) res.errors.push(copy.parse.inPast);

  res.ok = !!res.condition && res.errors.length === 0 && res.ambiguities.length === 0;
  if (res.condition) res.preview = renderPreview(res);
  return res;
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
    const when = parseWhen(`${conn === "in" ? "in " : ""}${lower}`, ctx.nowMs, ctx.tzOffsetMin ?? 0, 9, res);
    if (when === undefined) {
      res.errors.push(copy.parse.badDate(t));
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
    if (!op) res.ambiguities.push(copy.parse.needDirection(ticker, price));
    if (!verb || verb === "is" || verb === "trades" || verb === "stays") res.notes.push(copy.parse.atDeadlineMeaning);

    const prepWhen = pm[5] ? `${pm[5] === "this" || pm[5] === "next" ? pm[5] + " " : ""}${pm[6]}` : undefined;
    let deadline: number | undefined;
    if (!prepWhen) res.ambiguities.push(copy.parse.needDeadline);
    else {
      deadline = parseWhen(prepWhen, ctx.nowMs, 0, touch ? 20 : 16, res, true);
      if (deadline === undefined) res.errors.push(copy.parse.badDate(prepWhen));
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
    if (opp && sp[4] === undefined && parseWhen(opp, ctx.nowMs, ctx.tzOffsetMin ?? 0, 12, { ambiguities: [], notes: [] } as never) !== undefined) {
      on = parseWhen(opp, ctx.nowMs, ctx.tzOffsetMin ?? 0, 12, res);
      opp = undefined;
    }
    if (sp[4]) on = parseWhen(sp[4], ctx.nowMs, ctx.tzOffsetMin ?? 0, 12, res);
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
  res: Pick<ParseResult, "ambiguities" | "notes">,
  stockClock = false,
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
  const offMin = stockClock ? nyOffsetMinutes(nowMs) : tzOffsetMin;
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
      res.ambiguities.push(`"${p}" could be day/month or month/day — write it like "nov 1" or "2026-11-01"`);
      return undefined;
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
      dd -= wday === 6 ? 1 : 2;
      res.notes.push("weekend date moved to Friday's close (US market hours)");
    }
    unix = nyWallClockToUnix(target.getUTCFullYear(), target.getUTCMonth() + 1, dd, hour, minute);
  }
  return unix;
}

function wallToUnix(y: number, mo: number, d: number, h: number, mi: number, offMin: number): number {
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
  const cond = describeCondition(c);
  if (r.twoSided) return copy.preview.challenge(who, r.amountUsdg!, r.counterAmountUsdg!, cond);
  return copy.preview.payment(who, r.amountUsdg!, cond);
}

export function describeCondition(c: ConditionDraft): string {
  switch (c.kind) {
    case "TIME":
      return copy.describe.time(fmtDate(c.at));
    case "PRICE":
      return copy.describe.price(c.ticker, c.op, c.priceUsd, c.mode, fmtDate(c.deadline));
    case "SPORTS":
      return copy.describe.sports(c.team, c.result, c.opponent, c.on ? fmtDate(c.on) : undefined);
    case "MARKET":
      return copy.describe.market(c.venue, c.ref, c.answer);
    case "APPROVE":
      return c.mode === "PARTIES" ? copy.describe.parties : copy.describe.referee(c.referee.type === "handle" ? `@${c.referee.handle}` : c.referee.type === "address" ? short(c.referee.address) : "?");
  }
}

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function fmtDate(unix: number): string {
  return new Date(unix * 1000).toISOString().replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, " UTC");
}
