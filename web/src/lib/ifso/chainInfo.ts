import { getAddress, type Address } from "viem";
import type { Api } from "./api";
import type { IfsoConfig } from "./config";

export interface ChainInfo {
  chainId: number;
  escrow: Address;
  usdg: Address;
}

/**
 * The escrow address comes from the API (GET /healthz) and, when the site was built with a deployments file, must equal
 * it. A mismatch means the site and the service point at different deployments: nothing is signed against either.
 */
export async function resolveChainInfo(api: Pick<Api, "health">, cfg: IfsoConfig): Promise<ChainInfo> {
  const h = await api.health();
  if (h.chainId !== cfg.chain.id) throw new Error(`The service is on network ${h.chainId} but this site expects ${cfg.chain.id}. Nothing was signed.`);
  const fromApi = h.escrow ? getAddress(h.escrow) : undefined;
  if (cfg.escrow && fromApi && cfg.escrow !== fromApi) throw new Error("The service and this site disagree about the payment contract. Nothing was signed.");
  const escrow = fromApi ?? cfg.escrow;
  if (!escrow) throw new Error("The payment contract is not set up yet.");
  if (!cfg.usdg) throw new Error("The token address is not set up yet.");
  return { chainId: h.chainId, escrow, usdg: cfg.usdg };
}
