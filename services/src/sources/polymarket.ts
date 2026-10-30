// Polymarket resolution, read two independent ways:
//  1. Gamma API (public): closed + umaResolutionStatus + outcomePrices
//  2. Polygon Conditional Tokens: payoutNumerators / payoutDenominator for the market's conditionId
// CTF address and field semantics are (U) until checked against a Polygon RPC before launch.
import { createPublicClient, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { ctfAbi } from "../abi/external";
import { polymarketOutcome, type SourceReport } from "../core/outcome";
import { getJson } from "./http";

export const POLYGON_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const; // (U)

interface GammaMarket {
  slug: string;
  question: string;
  conditionId: Hex;
  closed: boolean;
  umaResolutionStatus?: string;
  outcomes: string; //      JSON string, e.g. "[\"Yes\",\"No\"]"
  outcomePrices: string; // JSON string, e.g. "[\"1\",\"0\"]"
  endDate?: string;
}

export async function fetchGamma(slug: string): Promise<{ report: SourceReport; market?: GammaMarket }> {
  const f = await getJson<GammaMarket[]>(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`);
  const m = f.body[0];
  const base = { provider: "polymarket-gamma", fetchedAt: f.fetchedAt, digest: f.digest } as const;
  if (!m) return { report: { ...base, status: "pending" } };
  const outcomes = JSON.parse(m.outcomes) as string[];
  if (outcomes.length !== 2 || outcomes[0]?.toLowerCase() !== "yes") return { report: { ...base, status: "void" }, market: m };
  const o = polymarketOutcome(m.closed, m.umaResolutionStatus === "resolved", JSON.parse(m.outcomePrices) as string[]);
  if (o === null) return { report: { ...base, status: "pending" }, market: m };
  return { report: o === 0 ? { ...base, status: "void" } : { ...base, status: "final", outcome: o }, market: m };
}

export async function fetchCtf(polygonRpc: string, conditionId: Hex): Promise<SourceReport> {
  const client = createPublicClient({ chain: polygon, transport: http(polygonRpc) });
  const fetchedAt = Math.floor(Date.now() / 1000);
  const den = await client.readContract({ address: POLYGON_CTF, abi: ctfAbi, functionName: "payoutDenominator", args: [conditionId] });
  const digestBase = { provider: "polygon-ctf", fetchedAt } as const;
  if (den === 0n) return { ...digestBase, status: "pending", digest: conditionId };
  const [yes, no] = await Promise.all([
    client.readContract({ address: POLYGON_CTF, abi: ctfAbi, functionName: "payoutNumerators", args: [conditionId, 0n] }),
    client.readContract({ address: POLYGON_CTF, abi: ctfAbi, functionName: "payoutNumerators", args: [conditionId, 1n] }),
  ]);
  const digest = `0x${(yes * 2n ** 128n + no).toString(16).padStart(64, "0")}` as Hex;
  if (yes === den && no === 0n) return { ...digestBase, status: "final", outcome: 1, digest };
  if (no === den && yes === 0n) return { ...digestBase, status: "final", outcome: 2, digest };
  return { ...digestBase, status: "void", digest };
}
