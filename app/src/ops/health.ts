// /readyz: each probe returns null when healthy, or a short reason.
import { formatEther, formatUnits, erc20Abi } from "viem";
import { sql } from "drizzle-orm";
import type IORedis from "ioredis";
import type { Deps } from "../workers/deps";

export type Probe = () => Promise<string | null>;
export const RPC_MAX_LAG_S = 60;

export const guard = (name: string, fn: () => Promise<string | null>): Probe => async () => {
  try {
    return await fn();
  } catch (e) {
    return `${name}: ${String((e as Error).message ?? e).slice(0, 120)}`;
  }
};

export function defaultProbes(deps: Deps, redis?: IORedis): Record<string, Probe> {
  const { db, clients, env } = deps;
  const probes: Record<string, Probe> = {
    db: guard("db down", async () => (await db.execute(sql`select 1`), null)),
    rpc: guard("rpc unreachable", async () => {
      const b = await clients.publicClient.getBlock();
      const lag = Math.floor(Date.now() / 1000) - Number(b.timestamp);
      return lag > RPC_MAX_LAG_S ? `rpc head lag ${lag}s (max ${RPC_MAX_LAG_S}s)` : null;
    }),
    balances: guard("balance check failed", async () => {
      const low: string[] = [];
      for (const [name, w, min] of [["relayer", clients.relayer, env.MIN_RELAYER_ETH], ["keeper", clients.keeper, env.MIN_KEEPER_ETH], ["resolver", clients.resolver, env.MIN_RESOLVER_ETH]] as const) {
        if (!w?.account) continue;
        const bal = await clients.publicClient.getBalance({ address: w.account.address });
        if (Number(formatEther(bal)) < min) low.push(`${name} ETH low`);
      }
      if (clients.resolver?.account) {
        const u = (await clients.publicClient.readContract({ address: clients.usdg, abi: erc20Abi, functionName: "balanceOf", args: [clients.resolver.account.address] })) as bigint;
        if (Number(formatUnits(u, 6)) < env.MIN_RESOLVER_USDG) low.push("resolver USDG low");
      }
      return low.length ? low.join(", ") : null;
    }),
  };
  if (redis) probes.redis = guard("redis down", async () => ((await redis.ping()) === "PONG" ? null : "redis bad reply"));
  return probes;
}

export async function readiness(probes: Record<string, Probe>): Promise<{ ok: boolean; reasons: string[] }> {
  const results = await Promise.all(Object.values(probes).map((p) => p()));
  const reasons = results.filter((r): r is string => r !== null);
  return { ok: reasons.length === 0, reasons };
}
