// The four provider reads the resolver depends on, behind one interface so tests can replay recorded
// fixtures through the same parsing code and so a failing provider can be swapped without touching the tick.
import type { Hex } from "viem";
import type { SourceReport } from "../core/outcome";
import { fetchScore } from "./theOddsApi";
import { fetchEvent } from "./theSportsDb";
import { fetchCtf, fetchGamma, type GammaMarket } from "./polymarket";

export interface SourceFetchers {
  oddsScore(apiKey: string, sportKey: string, eventId: string): Promise<SourceReport>;
  sportsDbEvent(key: string, idEvent: string): Promise<SourceReport>;
  gamma(slug: string): Promise<{ report: SourceReport; market?: GammaMarket }>;
  ctf(polygonRpc: string, conditionId: Hex): Promise<SourceReport>;
}

export const liveSources: SourceFetchers = {
  oddsScore: fetchScore,
  sportsDbEvent: fetchEvent,
  gamma: fetchGamma,
  ctf: fetchCtf,
};
