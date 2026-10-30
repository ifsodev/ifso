// Time-zone helpers for the bot: IANA zones (DST aware) without any dependency, built on Intl.

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const formatter = (tz: string) => {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
};

export function isValidZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{1,40}$/.test(tz)) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** UTC offset of `tz` at the instant `ms`, in minutes (Asia/Dubai = 240). */
export function zoneOffsetAt(tz: string, ms: number): number {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(Math.floor(ms / 1000) * 1000)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** Unix seconds for a wall clock time in `tz` (month is 0-based). In a spring-forward gap the later reading is used. */
export function zonedWallToUnix(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo, d, h, mi);
  let off = zoneOffsetAt(tz, naive);
  let guess = naive - off * 60_000;
  const off2 = zoneOffsetAt(tz, guess);
  if (off2 !== off) {
    off = off2;
    guess = naive - off * 60_000;
  }
  return Math.floor(guess / 1000);
}

export interface Zone {
  /** IANA name, when the user set one */
  name?: string;
  /** fixed offset in minutes, used when there is no name */
  offsetMin?: number;
}

export const zoneOffsetFor = (z: Zone | undefined, ms: number): number =>
  z?.name ? zoneOffsetAt(z.name, ms) : (z?.offsetMin ?? 0);

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

export const offsetLabel = (offMin: number) => {
  const a = Math.abs(offMin);
  return `UTC${offMin < 0 ? "-" : "+"}${Math.floor(a / 60)}${a % 60 ? ":" + pad(a % 60) : ""}`;
};

/** "2026-11-14 22:00 Asia/Dubai (2026-11-14 18:00 UTC)"; plain UTC when the user has no zone. */
export function formatWhen(unix: number, z?: Zone): string {
  const utc = `${stamp(unix * 1000)} UTC`;
  if (!z?.name && !z?.offsetMin) return utc;
  const off = zoneOffsetFor(z, unix * 1000);
  return `${stamp(unix * 1000 + off * 60_000)} ${z.name ?? offsetLabel(off)} (${utc})`;
}

/** Canonical spelling of a zone ("europe/london" -> "Europe/London"), or undefined when Intl does not know it. */
export function canonicalZone(tz: string): string | undefined {
  if (!isValidZone(tz)) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
