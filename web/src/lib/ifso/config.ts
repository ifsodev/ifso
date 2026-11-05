/**
 * Site configuration, read only from the environment (and the deployments JSON of the chosen chain).
 * `loadConfig(env)` is a pure function so tests can feed it any environment; `config` is the build-time value.
 */
import type { Address } from "viem";
import { getAddress, isAddress } from "viem";
import mainnetDeployment from "@/config/deployments/4663.json";
import testnetDeployment from "@/config/deployments/46630.json";
import forkDeployment from "@/config/deployments/31337.json";
import { FEATURE_ENV, sportsEnabledFrom, type FeatureEnv } from "./features";

export type ChainId = 4663 | 46630 | 31337;

export interface ChainProfile {
  id: ChainId;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  /** Known token address for this chain; test chains take theirs from the deployments file. */
  usdg?: Address;
}

export const USDG_MAINNET: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

export const CHAIN_PROFILES: Record<ChainId, ChainProfile> = {
  4663: { id: 4663, name: "Robinhood Chain", rpcUrl: "https://rpc.mainnet.chain.robinhood.com", explorerUrl: "https://robinhoodchain.blockscout.com", usdg: USDG_MAINNET },
  46630: { id: 46630, name: "Robinhood Chain Testnet", rpcUrl: "https://rpc.testnet.chain.robinhood.com", explorerUrl: "https://explorer.testnet.chain.robinhood.com" },
  31337: { id: 31337, name: "Local fork", rpcUrl: "http://127.0.0.1:8545", explorerUrl: "" },
};

interface DeploymentFile {
  chainId?: number;
  contracts?: Record<string, { address?: string } | undefined>;
}
const DEPLOYMENTS: Record<ChainId, DeploymentFile> = { 4663: mainnetDeployment, 46630: testnetDeployment, 31337: forkDeployment };

export interface SiteEnv extends FeatureEnv {
  NEXT_PUBLIC_API_URL?: string;
  NEXT_PUBLIC_CHAIN_ID?: string;
  NEXT_PUBLIC_RPC_URL?: string;
  NEXT_PUBLIC_EXPLORER_URL?: string;
  NEXT_PUBLIC_ESCROW_ADDRESS?: string;
  NEXT_PUBLIC_USDG_ADDRESS?: string;
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?: string;
}

export interface IfsoConfig {
  apiUrl: string;
  chain: ChainProfile;
  /** Escrow from the env or the deployments file; the API's /healthz is checked against it at run time. */
  escrow?: Address;
  usdg?: Address;
  walletConnectProjectId?: string;
  /** Origins the strict-CSP pages may talk to. */
  connectOrigins: string[];
  /** NEXT_PUBLIC_SPORTS_ENABLED=1: the match-result condition is offered. Off by default (DECISIONS row 44). */
  sportsEnabled: boolean;
}

const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const origin = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
};
const addr = (v: string | undefined, what: string): Address | undefined => {
  const s = clean(v);
  if (!s) return undefined;
  if (!isAddress(s)) throw new Error(`${what} is not an address`);
  return getAddress(s);
};

export function loadConfig(env: SiteEnv): IfsoConfig {
  const idRaw = clean(env.NEXT_PUBLIC_CHAIN_ID) ?? "4663";
  const id = Number(idRaw);
  if (id !== 4663 && id !== 46630 && id !== 31337) throw new Error(`NEXT_PUBLIC_CHAIN_ID must be 4663, 46630 or 31337 (got ${idRaw})`);
  const base = CHAIN_PROFILES[id];
  const chain: ChainProfile = { ...base, rpcUrl: clean(env.NEXT_PUBLIC_RPC_URL) ?? base.rpcUrl, explorerUrl: clean(env.NEXT_PUBLIC_EXPLORER_URL) ?? base.explorerUrl };
  const file = DEPLOYMENTS[id];
  const fromFile = (name: string) => addr(file.contracts?.[name]?.address, `deployments ${name}`);
  const escrow = addr(env.NEXT_PUBLIC_ESCROW_ADDRESS, "NEXT_PUBLIC_ESCROW_ADDRESS") ?? fromFile("IfsoEscrow");
  const usdg = addr(env.NEXT_PUBLIC_USDG_ADDRESS, "NEXT_PUBLIC_USDG_ADDRESS") ?? fromFile("MockUSDG") ?? fromFile("USDG") ?? chain.usdg;
  const apiUrl = (clean(env.NEXT_PUBLIC_API_URL) ?? "").replace(/\/+$/, "");
  const connectOrigins = [apiUrl && origin(apiUrl), origin(chain.rpcUrl)].filter((x): x is string => !!x);
  return { apiUrl, chain, escrow, usdg, walletConnectProjectId: clean(env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID), connectOrigins: [...new Set(connectOrigins)], sportsEnabled: sportsEnabledFrom(env) };
}

// Next inlines NEXT_PUBLIC_* only for literal `process.env.NAME` reads, so each one is spelled out.
export const config: IfsoConfig = loadConfig({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID,
  NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL,
  NEXT_PUBLIC_EXPLORER_URL: process.env.NEXT_PUBLIC_EXPLORER_URL,
  NEXT_PUBLIC_ESCROW_ADDRESS: process.env.NEXT_PUBLIC_ESCROW_ADDRESS,
  NEXT_PUBLIC_USDG_ADDRESS: process.env.NEXT_PUBLIC_USDG_ADDRESS,
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
  ...FEATURE_ENV,
});

export const explorerTx = (hash: string) => (config.chain.explorerUrl ? `${config.chain.explorerUrl}/tx/${hash}` : undefined);
