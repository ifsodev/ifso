// The Odds API needs a key we do not have, so its scores response is SYNTHESIZED from the recorded TheSportsDB
// events using the documented response shape (https://the-odds-api.com/liveapi/guides/v4/#get-scores).
// The output is marked `synthetic: true`. Replace with a real recording once a free-plan key exists.
//   bun scripts/synthesize-odds-fixtures.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex } from "viem";

const DIR = join(import.meta.dir, "../test/fixtures/resolver");
const src = JSON.parse(readFileSync(join(DIR, "epl-thesportsdb.json"), "utf8")) as { events: Record<string, string>[] };
const scores = src.events.map((e) => ({
  id: keccak256(toHex(`synthetic-oddsapi-${e.idEvent}`)).slice(2, 34),
  sport_key: "soccer_epl",
  sport_title: "EPL",
  commence_time: `${e.strTimestamp}Z`,
  completed: true,
  home_team: e.strHomeTeam,
  away_team: e.strAwayTeam,
  scores: [
    { name: e.strHomeTeam, score: e.intHomeScore },
    { name: e.strAwayTeam, score: e.intAwayScore },
  ],
  last_update: `${e.strTimestamp}Z`,
  // link back to the TheSportsDB event this row was derived from (not part of the real API shape)
  _derivedFrom: e.idEvent,
}));
writeFileSync(join(DIR, "epl-oddsapi.synthetic.json"), JSON.stringify({ synthetic: true, shape: "GET /v4/sports/soccer_epl/scores/?daysFrom=3", scores }, null, 2) + "\n");
console.log(`synthesized ${scores.length} scores`);
