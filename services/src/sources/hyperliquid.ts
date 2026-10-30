// Hyperliquid HIP-4 outcome markets. settledOutcome via the public info API. This is ONE source (the
// validators' settlement); a second independent read path is needed before HIP-4 conditions go live (U).
import { hip4Outcome, type SourceReport } from "../core/outcome";
import { getJson } from "./http";

interface SettledOutcome {
  settleFraction?: string | null;
  details?: string;
  spec?: unknown;
}

export async function fetchSettledOutcome(outcomeId: number, endpoint = "https://api.hyperliquid.xyz/info"): Promise<SourceReport> {
  const f = await getJson<SettledOutcome | null>(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "settledOutcome", outcome: outcomeId }),
  });
  const base = { provider: new URL(endpoint).host === "api.hyperliquid.xyz" ? "hyperliquid" : `hl-mirror:${new URL(endpoint).host}`, fetchedAt: f.fetchedAt, digest: f.digest } as const;
  const o = hip4Outcome(f.body?.settleFraction);
  if (o === null) return { ...base, status: "pending" };
  return o === 0 ? { ...base, status: "void" } : { ...base, status: "final", outcome: o };
}
