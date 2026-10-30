// Polymarket resolution, read two independent ways:
//  1. Gamma API (public): closed + umaResolutionStatus + outcomePrices
//  2. Polygon Conditional Tokens: payoutNumerators / payoutDenominator for the market's conditionId
// CTF address 0x4D97...6045 verified on Polygon (code present; payouts match Gamma on 20 recorded markets, 2026-10-30).
import { createPublicClient, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { ctfAbi } from "../abi/external";
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

export async function fetchGamma(slug: string): Promise<{ report: SourceReport; market?: GammaMarket }> {
  const f = await getJson<GammaMarket[]>(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`);
  const m = f.body[0];
  return { report: gammaReport(m, f.digest, f.fetchedAt), market: m };
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
