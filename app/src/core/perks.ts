// $IFSO holder perks: the tier table, limits and wording. Pure; the balance read lives in api/perks.ts.
// One config for the whole app: thresholds come from env (HOLDER_MIN_IFSO / WHALE_MIN_IFSO), never from a client.
import { copy } from "./copy";

export type Tier = "none" | "holder" | "whale";
export const TIER_RANK: Record<Tier, number> = { none: 0, holder: 1, whale: 2 };

export type PerkId = "batch" | "payroll" | "limits_holder" | "limits_whale";

export interface TierConfig {
  tokenConfigured: boolean;
  /** whole-token thresholds */
  holderMin: number;
  whaleMin: number;
  decimals: number;
}

/** Whole-token threshold as the raw on-chain amount. */
export const rawThreshold = (whole: number, decimals: number): bigint => BigInt(whole) * 10n ** BigInt(decimals);

/** Tier from a raw balance. Exactly at the threshold counts. */
export function tierFromBalance(balance: bigint, c: Pick<TierConfig, "holderMin" | "whaleMin" | "decimals">): Tier {
  if (balance >= rawThreshold(c.whaleMin, c.decimals)) return "whale";
  if (balance >= rawThreshold(c.holderMin, c.decimals)) return "holder";
  return "none";
}

export interface Limits {
  /** payments in one createBatch run (0 = the feature is locked) */
  batchSize: number;
  /** scheduled payments that may exist at once (0 = locked) */
  scheduledPayments: number;
  /** multiplier on the per-wallet hourly relay budget */
  relayBudgetFactor: number;
}

export const LIMITS: Record<Tier, Limits> = {
  none: { batchSize: 0, scheduledPayments: 0, relayBudgetFactor: 1 },
  holder: { batchSize: 50, scheduledPayments: 25, relayBudgetFactor: 2 },
  whale: { batchSize: 200, scheduledPayments: 100, relayBudgetFactor: 5 },
};

const PERKS: { id: PerkId; min: Tier; text: string }[] = [
  { id: "batch", min: "holder", text: copy.perks.batchPerk },
  { id: "payroll", min: "holder", text: copy.perks.payrollPerk },
  { id: "limits_holder", min: "holder", text: copy.perks.limitsHolder },
  { id: "limits_whale", min: "whale", text: copy.perks.limitsWhale },
];

const fmt = (n: number) => n.toLocaleString("en-US");

export interface PerkView {
  id: PerkId;
  text: string;
  requires: Tier;
  /** whole tokens to hold */
  requiresIfso: number;
  unlockText: string;
}

export interface PerksState {
  tier: Tier;
  tokenLive: boolean;
  unlocked: PerkView[];
  locked: PerkView[];
  limits: Limits;
  wording: string;
  note: string;
}

export function perksFor(tier: Tier, c: TierConfig): PerksState {
  const view = (p: (typeof PERKS)[number]): PerkView => {
    const need = p.min === "whale" ? c.whaleMin : c.holderMin;
    return { id: p.id, text: p.text, requires: p.min, requiresIfso: need, unlockText: p.min === "whale" ? copy.perks.lockedWhale(fmt(need)) : copy.perks.lockedHolder(fmt(need)) };
  };
  // fail closed: no token configured means everyone is "none", whatever was passed in
  const eff: Tier = c.tokenConfigured ? tier : "none";
  const unlocked = PERKS.filter((p) => TIER_RANK[eff] >= TIER_RANK[p.min]).map(view);
  const locked = PERKS.filter((p) => TIER_RANK[eff] < TIER_RANK[p.min]).map(view);
  const wording = !c.tokenConfigured ? copy.perks.tokenNotLive(fmt(c.holderMin)) : eff === "none" ? copy.perks.lockedHolder(fmt(c.holderMin)) : eff === "holder" ? copy.perks.lockedWhale(fmt(c.whaleMin)) : "";
  return { tier: eff, tokenLive: c.tokenConfigured, unlocked, locked, limits: LIMITS[eff], wording, note: copy.perks.noCash };
}
