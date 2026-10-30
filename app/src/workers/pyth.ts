// Pyth Hermes: signed price update for a given publish time (first update at/after `ts`), for the Pyth
// adapter path. Endpoint shape and the API-key header required since the 2026-07-31 Core upgrade are (U).
import type { Hex } from "viem";
import { pythAbi } from "../abi/external";
import { RHC } from "../config/chain";
import type { Deps } from "./deps";

export async function fetchPythUpdate(deps: Deps, priceId: Hex, ts: number): Promise<{ data: Hex[]; fee: bigint } | undefined> {
  const url = `${deps.env.PYTH_HERMES_URL}/v2/updates/price/${ts}?ids[]=${priceId}&encoding=hex`;
  const res = await fetch(url, { headers: deps.env.PYTH_API_KEY ? { "x-api-key": deps.env.PYTH_API_KEY } : {} });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { binary?: { data?: string[] } };
  const data = (body.binary?.data ?? []).map((d) => (d.startsWith("0x") ? d : `0x${d}`) as Hex);
  if (!data.length) return undefined;
  const fee = await deps.clients.publicClient.readContract({ address: RHC.PYTH_CORE, abi: pythAbi, functionName: "getUpdateFee", args: [data] });
  return { data, fee };
}
