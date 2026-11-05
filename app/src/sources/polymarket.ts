// Polymarket resolution, read two independent ways:
//  1. Gamma API (public): closed + umaResolutionStatus + outcomePrices
//  2. Polygon Conditional Tokens: payoutNumerators / payoutDenominator for the market's conditionId
// CTF address 0x4D97...6045 verified on Polygon (code present; payouts match Gamma on 20 recorded markets, 2026-10-30).
import { createPublicClient, http, keccak256, toHex, type Hex } from "viem";
import { polygon } from "viem/chains";
import { ctfAbi } from "../abi/external";
import { copy } from "../core/copy";
import { polymarketOutcome, type SourceReport } from "../core/outcome";
import { getJson } from "./http";

export const POLYGON_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const; // ConditionalTokens, checked 2026-10-30

export interface GammaMarket {
  slug: string;
  question: string;
  conditionId: Hex;
  closed: boolean;
  umaResolutionStatus?: string;
  outcomes: string; //      JSON string, e.g. "[\"Yes\",\"No\"]"
  outcomePrices: string; // JSON string, e.g. "[\"1\",\"0\"]"
  endDate?: string;
  /** Gamma's own signals; absent on old recorded fixtures. */
  active?: boolean;
  closedTime?: string; //   set once the market closed (can be BEFORE endDate: early resolution)
  liquidityNum?: number;
  volumeNum?: number;
  /** the short name polymarket.com shows for one market of a multi-market event (e.g. "↑ 95,000"); "" on single ones */
  groupItemTitle?: string;
}

/** Gamma `/events?slug=` row (trimmed to what we read). */
export interface GammaEvent {
  slug: string;
  title?: string;
  closed?: boolean;
  markets?: GammaMarket[];
}

/** Gamma market -> report. Pure, so recorded fixtures replay through the same code. */
export function gammaReport(m: GammaMarket | undefined, digest: Hex, fetchedAt: number): SourceReport {
  const base = { provider: "polymarket-gamma", fetchedAt, digest } as const;
  if (!m) return { ...base, status: "pending" };
  let outcomes: string[];
  let prices: string[];
  try {
    outcomes = JSON.parse(m.outcomes) as string[];
    prices = JSON.parse(m.outcomePrices) as string[];
  } catch {
    return { ...base, status: "pending" };
  }
  if (outcomes.length !== 2 || outcomes[0]?.toLowerCase() !== "yes" || outcomes[1]?.toLowerCase() !== "no") return { ...base, status: "void" };
  const o = polymarketOutcome(m.closed, m.umaResolutionStatus === "resolved", prices);
  if (o === null) return { ...base, status: "pending" };
  return o === 0 ? { ...base, status: "void" } : { ...base, status: "final", outcome: o };
}

/** The single-market endpoint: the list endpoint (`/markets?slug=`) leaves closed markets out unless `closed=true`, so a
 *  RESOLVED market would read as missing (pending forever). This one answers for open and closed markets; 404 = unknown slug. */
export async function fetchGamma(slug: string): Promise<{ report: SourceReport; market?: GammaMarket }> {
  const url = `https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`;
  const f = await getJson<GammaMarket>(url).catch((e: Error) => {
    if (e.message.startsWith("404 ")) return null;
    throw e;
  });
  if (!f) return { report: gammaReport(undefined, keccak256(toHex(`404 ${slug}`)), Math.floor(Date.now() / 1000)) };
  return { report: gammaReport(f.body, f.digest, f.fetchedAt), market: f.body };
}

/** CTF payouts -> report. Final only when one side holds the whole denominator; anything else is VOID. */
export function ctfReport(conditionId: Hex, den: bigint, yes: bigint, no: bigint, fetchedAt: number): SourceReport {
  const base = { provider: "polygon-ctf", fetchedAt } as const;
  if (den === 0n) return { ...base, status: "pending", digest: conditionId };
  const digest = `0x${(yes * 2n ** 128n + no).toString(16).padStart(64, "0")}` as Hex;
  if (yes === den && no === 0n) return { ...base, status: "final", outcome: 1, digest };
  if (no === den && yes === 0n) return { ...base, status: "final", outcome: 2, digest };
  return { ...base, status: "void", digest };
}

export async function fetchCtf(polygonRpc: string, conditionId: Hex): Promise<SourceReport> {
  const client = createPublicClient({ chain: polygon, transport: http(polygonRpc) });
  const fetchedAt = Math.floor(Date.now() / 1000);
  const den = await client.readContract({ address: POLYGON_CTF, abi: ctfAbi, functionName: "payoutDenominator", args: [conditionId] });
  if (den === 0n) return ctfReport(conditionId, den, 0n, 0n, fetchedAt);
  const [yes, no] = await Promise.all([
    client.readContract({ address: POLYGON_CTF, abi: ctfAbi, functionName: "payoutNumerators", args: [conditionId, 0n] }),
    client.readContract({ address: POLYGON_CTF, abi: ctfAbi, functionName: "payoutNumerators", args: [conditionId, 1n] }),
  ]);
  return ctfReport(conditionId, den, yes, no, fetchedAt);
}

/** How many open markets an event answer lists before "and N more". */
export const EVENT_PICK_MAX = 5;

/** A Polymarket ref (slug or polymarket.com link) -> the market slug, or the event slug when the link names only an event.
 *  /event/<event>/<market> and /market/<market> name the market in the LAST segment; /event/<event> names only the event. */
export function parsePolymarketLink(ref: string): { market: string } | { event: string } | { invalid: true } {
  const m = ref.match(/^https?:\/\/(?:www\.)?polymarket\.com\/([^?#]*)/i);
  if (!m) return { market: ref };
  let parts: string[];
  try {
    parts = m[1]!.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  } catch {
    return { invalid: true }; // a malformed %-escape (URIError): no market can be named by it
  }
  if (parts[0] === "event" && parts.length === 2) return { event: parts[1]! };
  return { market: parts[parts.length - 1] ?? "" };
}

export async function fetchGammaEvent(slug: string): Promise<GammaEvent | undefined> {
  const f = await getJson<GammaEvent[]>(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
  return Array.isArray(f.body) ? f.body.find((e) => e.slug === slug) : undefined;
}

export type PolymarketRefResult = { ok: true; slug: string } | { ok: false; message: string };

/** Turns what the user typed into one market slug, never guessing: an event link with one open market becomes that
 *  market; several open markets -> a short list to pick from; none -> a plain answer. A slug Gamma does not know as an
 *  event is tried as a market (single-market pages use the same slug), where the allow-list answers for it. */
export async function resolvePolymarketRef(ref: string, getEvent: (slug: string) => Promise<GammaEvent | undefined> = fetchGammaEvent): Promise<PolymarketRefResult> {
  const p = parsePolymarketLink(ref);
  if ("invalid" in p) return { ok: false, message: copy.parse.notPolymarketLink };
  if ("market" in p) return { ok: true, slug: p.market };
  const ev = await getEvent(p.event);
  if (!ev || !Array.isArray(ev.markets)) return { ok: true, slug: p.event };
  const open = ev.markets.filter((m) => !m.closed && m.active !== false);
  const title = ev.title || ev.slug;
  if (open.length === 1) return { ok: true, slug: open[0]!.slug };
  if (!open.length) return { ok: false, message: copy.parse.marketNoneOpen(title) };
  const shown = open.slice(0, EVENT_PICK_MAX).map((m) => copy.parse.marketPickLine(m.groupItemTitle || m.question, m.slug));
  return { ok: false, message: copy.parse.marketPick(title, shown.join("\n"), open.length - shown.length) };
}
