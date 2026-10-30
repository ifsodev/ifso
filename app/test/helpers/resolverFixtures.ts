// Recorded resolver fixtures (test/fixtures/resolver/) replayed through the real source parsers, behind the
// same SourceFetchers interface the resolver uses in production.
import { keccak256, toHex, type Hex } from "viem";
import type { SourceReport } from "../../src/core/outcome";
import type { SourceFetchers } from "../../src/sources";
import { ctfReport, gammaReport, type GammaMarket } from "../../src/sources/polymarket";
import { toReport as oddsReport, type OddsApiScore } from "../../src/sources/theOddsApi";
import { toReport as sdbReport, type SportsDbEvent } from "../../src/sources/theSportsDb";
import tsdbFile from "../fixtures/resolver/epl-thesportsdb.json";
import oddsFile from "../fixtures/resolver/epl-oddsapi.synthetic.json";
import pmFile from "../fixtures/resolver/polymarket.json";

export const FETCHED_AT = 1_800_000_000;
export const digestOf = (v: unknown): Hex => keccak256(toHex(JSON.stringify(v)));

export const eplEvents = tsdbFile.events as unknown as (SportsDbEvent & { idEvent: string; strTimestamp: string })[];
export const oddsScores = oddsFile.scores as unknown as (OddsApiScore & { _derivedFrom: string })[];
export const oddsFileIsSynthetic = (oddsFile as { synthetic?: boolean }).synthetic === true;
export const pmMarkets = (pmFile.markets as unknown as { gamma: GammaMarket; ctf: { payoutDenominator: string; payoutNumerators: [string, string] } }[]).map((m) => ({
  ...m,
  gamma: { ...m.gamma, conditionId: `0x${m.gamma.conditionId}` as Hex }, // stored without 0x, see the fixture note
}));

/** Expected football outcome from the recorded final score, computed here independently of the resolver code. */
export const expectedFootball = (e: { intHomeScore: string | null; intAwayScore: string | null }) => {
  const h = Number(e.intHomeScore), a = Number(e.intAwayScore);
  return h > a ? 1 : h < a ? 2 : 3;
};
export const expectedPolymarket = (g: GammaMarket) => (JSON.parse(g.outcomePrices)[0] === "1" ? 1 : 2);

export interface FixtureOverrides {
  tsdb?: Record<string, SportsDbEvent | undefined>;
  odds?: Record<string, OddsApiScore | undefined>;
  gamma?: Record<string, GammaMarket | undefined>;
  ctf?: Record<string, { den: bigint; yes: bigint; no: bigint } | undefined>;
  /** providers that throw (network failure) */
  down?: ("odds" | "tsdb" | "gamma" | "ctf")[];
}

/** SourceFetchers backed by the fixtures. Keys: TheSportsDB idEvent, Odds API id, Gamma slug, conditionId. */
export function fixtureSources(o: FixtureOverrides = {}): SourceFetchers {
  const tsdb = new Map<string, SportsDbEvent | undefined>(eplEvents.map((e) => [e.idEvent, e]));
  const odds = new Map<string, OddsApiScore | undefined>(oddsScores.map((s) => [s.id, s]));
  const gamma = new Map<string, GammaMarket | undefined>(pmMarkets.map((m) => [m.gamma.slug, m.gamma]));
  const ctf = new Map<string, { den: bigint; yes: bigint; no: bigint } | undefined>(
    pmMarkets.map((m) => [m.gamma.conditionId, { den: BigInt(m.ctf.payoutDenominator), yes: BigInt(m.ctf.payoutNumerators[0]), no: BigInt(m.ctf.payoutNumerators[1]) }]),
  );
  for (const [k, v] of Object.entries(o.tsdb ?? {})) tsdb.set(k, v);
  for (const [k, v] of Object.entries(o.odds ?? {})) odds.set(k, v);
  for (const [k, v] of Object.entries(o.gamma ?? {})) gamma.set(k, v);
  for (const [k, v] of Object.entries(o.ctf ?? {})) ctf.set(k, v);
  const down = new Set(o.down ?? []);
  const t = () => Math.floor(Date.now() / 1000);
  const guard = (n: "odds" | "tsdb" | "gamma" | "ctf") => {
    if (down.has(n)) throw new Error(`${n} is down`);
  };
  return {
    async oddsScore(_key, _sport, id): Promise<SourceReport> {
      guard("odds");
      const e = odds.get(id);
      return oddsReport(e, digestOf(e ?? null), t());
    },
    async sportsDbEvent(_key, id): Promise<SourceReport> {
      guard("tsdb");
      const e = tsdb.get(id);
      return sdbReport(e, digestOf(e ?? null), t());
    },
    async gamma(slug) {
      guard("gamma");
      const m = gamma.get(slug);
      return { report: gammaReport(m, digestOf(m ?? null), t()), market: m };
    },
    async ctf(_rpc, conditionId): Promise<SourceReport> {
      guard("ctf");
      const c = ctf.get(conditionId);
      return c ? ctfReport(conditionId, c.den, c.yes, c.no, t()) : ctfReport(conditionId, 0n, 0n, 0n, t());
    },
  };
}
