// The Odds API (the-odds-api.com) — scores endpoint. ToS (updated 2026-08-31) allows commercial display and
// storage; it bans redistributing the data as a standalone product or via our own API. We never re-serve it:
// only a derived outcome index plus a hash of the evidence goes on-chain. (U: legal judgment.)
// Launch scope: LEAGUE fixtures only (no knockout ties), so "90 minutes + stoppage" == the final score.
import { footballOutcome, type SourceReport } from "../core/outcome";
import { getJson } from "./http";

export interface OddsApiScore {
  id: string;
  sport_key: string;
  commence_time: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: { name: string; score: string }[] | null;
  last_update: string | null;
}

export interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
}

const BASE = "https://api.the-odds-api.com/v4";

export async function listEvents(apiKey: string, sportKey: string) {
  return getJson<OddsApiEvent[]>(`${BASE}/sports/${encodeURIComponent(sportKey)}/events?apiKey=${encodeURIComponent(apiKey)}`);
}

export async function fetchScore(apiKey: string, sportKey: string, eventId: string): Promise<SourceReport> {
  const f = await getJson<OddsApiScore[]>(
    `${BASE}/sports/${encodeURIComponent(sportKey)}/scores/?daysFrom=3&eventIds=${encodeURIComponent(eventId)}&apiKey=${encodeURIComponent(apiKey)}`,
  );
  return toReport(f.body.find((e) => e.id === eventId), f.digest, f.fetchedAt);
}

export function toReport(e: OddsApiScore | undefined, digest: `0x${string}`, fetchedAt: number): SourceReport {
  if (!e || !e.completed || !e.scores) return { provider: "theoddsapi", fetchedAt, status: "pending", digest };
  const home = Number(e.scores.find((s) => s.name === e.home_team)?.score);
  const away = Number(e.scores.find((s) => s.name === e.away_team)?.score);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return { provider: "theoddsapi", fetchedAt, status: "pending", digest };
  return { provider: "theoddsapi", fetchedAt, status: "final", outcome: footballOutcome(home, away), digest };
}
