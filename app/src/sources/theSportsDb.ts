// TheSportsDB (thesportsdb.com) as the second, independent football source. Free test key "3" for dev;
// production needs a paid key, and its ToS for derived on-chain results is (U). Replaceable by any provider
// whose terms allow it (never API-Football: its terms grant no publishing licence).
import { footballOutcome, type SourceReport } from "../core/outcome";
import { getJson } from "./http";

interface SportsDbEvent {
  idEvent: string;
  strStatus: string | null; // "Match Finished", "FT", "Postponed", "Abandoned", "Not Started", ...
  intHomeScore: string | null;
  intAwayScore: string | null;
  strHomeTeam: string;
  strAwayTeam: string;
}

const VOID_STATUSES = /postponed|abandoned|cancel+ed|suspended|awarded/i;
const FINAL_STATUSES = /^(match finished|ft|finished)$/i;

export async function fetchEvent(key: string, idEvent: string): Promise<SourceReport> {
  const f = await getJson<{ events: SportsDbEvent[] | null }>(
    `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(key)}/lookupevent.php?id=${encodeURIComponent(idEvent)}`,
  );
  return toReport(f.body.events?.[0], f.digest, f.fetchedAt);
}

export function toReport(e: SportsDbEvent | undefined, digest: `0x${string}`, fetchedAt: number): SourceReport {
  const base = { provider: "thesportsdb", fetchedAt, digest } as const;
  if (!e || !e.strStatus) return { ...base, status: "pending" };
  if (VOID_STATUSES.test(e.strStatus)) return { ...base, status: "void" };
  if (!FINAL_STATUSES.test(e.strStatus.trim())) return { ...base, status: "pending" };
  const h = Number(e.intHomeScore);
  const a = Number(e.intAwayScore);
  if (e.intHomeScore === null || e.intAwayScore === null || !Number.isFinite(h) || !Number.isFinite(a)) return { ...base, status: "pending" };
  return { ...base, status: "final", outcome: footballOutcome(h, a) };
}
