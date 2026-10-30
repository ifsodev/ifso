// Holder tier, read on the SERVER from the token's balanceOf at request time (short cache). The client never sends a
// tier. Fails closed: no token configured, or a failed read, means "none" and no perk. Core features never call this.
import { parseAbi, type Address } from "viem";
import { tierFromBalance, type Tier, type TierConfig } from "../core/perks";
import type { Deps } from "../workers/deps";

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const MAX_CACHE = 5_000;
const cache = new WeakMap<object, Map<string, { tier: Tier; at: number }>>();

export const tierConfig = (deps: Deps): TierConfig => ({
  tokenConfigured: Boolean(deps.env.IFSO_TOKEN_ADDRESS),
  holderMin: deps.env.HOLDER_MIN_IFSO,
  whaleMin: Math.max(deps.env.WHALE_MIN_IFSO, deps.env.HOLDER_MIN_IFSO),
  decimals: deps.env.IFSO_TOKEN_DECIMALS,
});

export async function holderTier(deps: Deps, address: Address, now = Date.now()): Promise<Tier> {
  const token = deps.env.IFSO_TOKEN_ADDRESS as Address | undefined;
  if (!token) return "none"; // no RPC call before the token exists
  let m = cache.get(deps);
  if (!m) cache.set(deps, (m = new Map()));
  const key = address.toLowerCase();
  const hit = m.get(key);
  if (hit && now - hit.at < deps.env.PERKS_CACHE_SECONDS * 1000) return hit.tier;
  let tier: Tier;
  try {
    const bal = await deps.clients.publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [address] });
    tier = tierFromBalance(bal, tierConfig(deps));
  } catch {
    return "none"; // fail closed, and do not cache the failure
  }
  if (m.size >= MAX_CACHE) m.clear();
  m.set(key, { tier, at: now });
  return tier;
}
