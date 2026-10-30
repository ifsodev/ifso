// Multi-source agreement for the outcome resolver service. The service proposes on-chain ONLY when at least
// two independent providers report the same final result. Only a derived result (outcome index) and a hash of
// the evidence bundle go on-chain, never raw provider data (data-licence hygiene).
import { keccak256, toHex, type Hex } from "viem";

export type SportsOutcome = 0 | 1 | 2 | 3; // 0 VOID, 1 HOME, 2 AWAY, 3 DRAW
export type BinaryOutcome = 0 | 1 | 2; //     0 VOID, 1 YES, 2 NO

export interface SourceReport {
  provider: string; // "theoddsapi" | "thesportsdb" | "polymarket-gamma" | "polygon-ctf" | "hyperliquid"
  fetchedAt: number;
  status: "final" | "pending" | "void";
  outcome?: number; // valid when status === "final"
  digest: Hex; // keccak256 of the raw response body (kept off-chain)
}

export interface Agreement {
  decision: number | null; // outcome index to propose, or null (do not propose)
  reason: string;
  sourcesHash: Hex;
  providers: string[];
  /** true when independent sources contradict each other (as opposed to "not final yet"): alert, never propose */
  conflict?: boolean;
}

export function canonicalEvidence(reports: SourceReport[]): string {
  const rows = [...reports]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map((r) => ({ p: r.provider, t: r.fetchedAt, s: r.status, o: r.outcome ?? null, d: r.digest }));
  return JSON.stringify(rows);
}

export function sourcesHash(reports: SourceReport[]): Hex {
  return keccak256(toHex(canonicalEvidence(reports)));
}

export function agree(reports: SourceReport[], minSources = 2): Agreement {
  const latest = new Map<string, SourceReport>();
  for (const r of reports) {
    const prev = latest.get(r.provider);
    if (!prev || r.fetchedAt > prev.fetchedAt) latest.set(r.provider, r);
  }
  const rs = [...latest.values()];
  const base = { sourcesHash: sourcesHash(rs), providers: rs.map((r) => r.provider).sort() };
  if (rs.length < minSources) return { decision: null, reason: `need ${minSources} independent sources, have ${rs.length}`, ...base };

  const finals = rs.filter((r) => r.status === "final");
  const voids = rs.filter((r) => r.status === "void");
  if (finals.length && voids.length) return { decision: null, reason: "sources disagree (final vs void): hold for review", conflict: true, ...base };
  if (voids.length >= minSources) return { decision: 0, reason: "postponed / abandoned / invalid per all sources", ...base };
  if (finals.length < minSources) return { decision: null, reason: "not final on enough sources yet", ...base };
  const outcomes = new Set(finals.map((r) => r.outcome));
  if (outcomes.size !== 1) return { decision: null, reason: "sources disagree on the result: hold for review", conflict: true, ...base };
  const o = finals[0]!.outcome!;
  return { decision: o, reason: `${finals.length} sources agree`, ...base };
}

/** Football 1X2 from a final score. "90 minutes + stoppage" questions must be fed regulation-time scores. */
export function footballOutcome(home: number, away: number): SportsOutcome {
  return home > away ? 1 : home < away ? 2 : 3;
}

/** Outcome mask for a sports draft. Bit i set = outcome i counts as met. */
export function sportsMask(teamIsHome: boolean, result: "WIN" | "DRAW" | "WIN_OR_DRAW" | "LOSE"): bigint {
  const HOME = 1n << 1n, AWAY = 1n << 2n, DRAW = 1n << 3n;
  const mine = teamIsHome ? HOME : AWAY;
  const theirs = teamIsHome ? AWAY : HOME;
  switch (result) {
    case "WIN":
      return mine;
    case "DRAW":
      return DRAW;
    case "WIN_OR_DRAW":
      return mine | DRAW;
    case "LOSE":
      return theirs;
  }
}

export function binaryMask(answer: "YES" | "NO"): bigint {
  return answer === "YES" ? 1n << 1n : 1n << 2n;
}

/** Polymarket: outcomePrices like ["1","0"] once resolved. Non-binary or partial payouts => VOID. */
export function polymarketOutcome(closed: boolean, umaResolved: boolean, outcomePrices: string[]): BinaryOutcome | null {
  if (!closed || !umaResolved) return null;
  const [y, n] = outcomePrices.map(Number);
  if (y === 1 && n === 0) return 1;
  if (y === 0 && n === 1) return 2;
  return 0;
}

/** Hyperliquid HIP-4 settledOutcome.settleFraction: "1.0" YES, "0.0" NO, anything else VOID. */
export function hip4Outcome(settleFraction: string | null | undefined): BinaryOutcome | null {
  if (settleFraction === null || settleFraction === undefined) return null;
  const f = Number(settleFraction);
  if (f === 1) return 1;
  if (f === 0) return 2;
  return 0;
}

/** Spec hash for a question: canonical JSON of the rules (stored off-chain at specURI; hash on-chain). */
export function questionSpecHash(spec: Record<string, unknown>): Hex {
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])) : v;
  return keccak256(toHex(JSON.stringify(sortKeys(spec))));
}
