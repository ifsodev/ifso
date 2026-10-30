// Fixture lookup for SPORTS drafts ("arsenal win"): finds the team's next league fixture via The Odds API
// events list (cached), then the matching TheSportsDB event id for the second source.
import { listEvents, type OddsApiEvent } from "../sources/theOddsApi";
import { getJson } from "../sources/http";
import type { Deps } from "../workers/deps";
import type { FootballFixture } from "../workers/resolver";

/** League (not cup) competitions only at launch: no extra time / penalties ambiguity. */
export const LEAGUES = ["soccer_epl", "soccer_spain_la_liga", "soccer_italy_serie_a", "soccer_germany_bundesliga", "soccer_france_ligue_one", "soccer_usa_mls"];

let cache: { at: number; events: OddsApiEvent[] } | undefined;

export function normTeam(s: string): string {
  return s.toLowerCase().replace(/\./g, "").replace(/\b(fc|cf|afc|sc|ac)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export function matchFixtures(events: OddsApiEvent[], team: string, opponent: string | undefined, on: number | undefined, nowSec: number) {
  const t = normTeam(team);
  const o = opponent ? normTeam(opponent) : undefined;
  const hit = (name: string, q: string) => normTeam(name).includes(q) || q.includes(normTeam(name));
  return events
    .filter((e) => Date.parse(e.commence_time) / 1000 > nowSec)
    .filter((e) => hit(e.home_team, t) || hit(e.away_team, t))
    .filter((e) => !o || hit(e.home_team, o) || hit(e.away_team, o))
    .filter((e) => !on || Math.abs(Date.parse(e.commence_time) / 1000 - on) < 36 * 3600)
    .sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
}

async function loadEvents(deps: Deps): Promise<OddsApiEvent[] | undefined> {
  const key = deps.env.ODDS_API_KEY;
  if (!key) return undefined;
  if (!cache || Date.now() - cache.at > 10 * 60_000) {
    const lists = await Promise.all(LEAGUES.map((l) => listEvents(key, l).then((r) => r.body).catch(() => [] as OddsApiEvent[])));
    cache = { at: Date.now(), events: lists.flat() };
  }
  return cache.events;
}

export const LEAGUE_NAMES: Record<string, string> = {
  soccer_epl: "Premier League",
  soccer_spain_la_liga: "La Liga",
  soccer_italy_serie_a: "Serie A",
  soccer_germany_bundesliga: "Bundesliga",
  soccer_france_ligue_one: "Ligue 1",
  soccer_usa_mls: "MLS",
};

export interface FixtureMatch {
  home: string;
  away: string;
  league: string;
  commence: number; // unix seconds
  /** which side of the fixture matched the typed team name */
  matched: string;
}

/** Upcoming league fixtures for a typed team name, soonest first. undefined = no odds key, so no lookup is possible. */
export async function listFixtureMatches(deps: Deps, team: string, opponent?: string, on?: number): Promise<FixtureMatch[] | undefined> {
  const events = await loadEvents(deps);
  if (!events) return undefined;
  const t = normTeam(team);
  return matchFixtures(events, team, opponent, on, Math.floor(Date.now() / 1000)).map((e) => ({
    home: e.home_team,
    away: e.away_team,
    league: LEAGUE_NAMES[e.sport_key] ?? e.sport_key,
    commence: Math.floor(Date.parse(e.commence_time) / 1000),
    matched: normTeam(e.home_team).includes(t) || t.includes(normTeam(e.home_team)) ? e.home_team : e.away_team,
  }));
}

export async function findFixture(deps: Deps, team: string, opponent?: string, on?: number): Promise<{ fixture?: FootballFixture; teamIsHome?: boolean; ambiguous?: string[] }> {
  const events = await loadEvents(deps);
  if (!events) return {};
  const matches = matchFixtures(events, team, opponent, on, Math.floor(Date.now() / 1000));
  if (!matches.length) return {};
  const first = matches[0]!;
  const sameTeamNames = new Set(matches.slice(0, 3).map((m) => (normTeam(m.home_team).includes(normTeam(team)) ? m.home_team : m.away_team)));
  if (sameTeamNames.size > 1) return { ambiguous: [...sameTeamNames] };
  const teamIsHome = normTeam(first.home_team).includes(normTeam(team)) || normTeam(team).includes(normTeam(first.home_team));
  const commence = Math.floor(Date.parse(first.commence_time) / 1000);
  const sportsDbEventId = await findSportsDbEvent(deps, first.home_team, first.away_team, first.commence_time.slice(0, 10)).catch(() => undefined);
  return {
    teamIsHome,
    fixture: { sportKey: first.sport_key, oddsApiEventId: first.id, sportsDbEventId, home: first.home_team, away: first.away_team, commenceTime: commence },
  };
}

/** TheSportsDB event search by "Home_vs_Away" and date. Naming differences between providers are (U). */
export async function findSportsDbEvent(deps: Deps, home: string, away: string, dateIso: string): Promise<string | undefined> {
  const q = `${home}_vs_${away}`.replace(/\s+/g, "_");
  const r = await getJson<{ event: { idEvent: string; dateEvent: string }[] | null }>(
    `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(deps.env.THESPORTSDB_KEY)}/searchevents.php?e=${encodeURIComponent(q)}&d=${dateIso}`,
  );
  return r.body.event?.find((e) => e.dateEvent === dateIso)?.idEvent;
}
