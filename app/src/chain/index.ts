// viem clients for Robinhood Chain. Three separate hot keys, each funded with a little ETH only:
//  relayer  - submits claims, gasless creates/accepts, decisions, refund redirects (cannot redirect funds)
//  keeper   - settle + refund sweeps (permissionless calls)
//  resolver - registers questions, proposes outcomes with USDG bonds, disputes, finalizes
import { createWalletClient, type Address } from "viem";
import type { Account } from "viem/accounts";
import { rhc, rhcTestnet } from "../config/chain";
import { rpcUrls, type Env } from "../config/env";
import { loadHotKey } from "./keys";
import { createPublicClient } from "viem";
import { makeTransport, type RpcOptions } from "./rpc";

export function chainFor(env: Env) {
  return env.CHAIN_ID === 46630 ? rhcTestnet : env.CHAIN_ID === 31337 ? { ...rhc, id: 31337 } : rhc;
}

export function makeClients(env: Env, rpc: Omit<RpcOptions, "chain"> = {}) {
  const chain = chainFor(env);
  const urls = rpcUrls(env);
  const transport = makeTransport(urls, { ...rpc, chain });
  // RHC makes ~10 blocks a second: poll for receipts every 250 ms, not viem's 4 s default
  const pollingInterval = 250;
  const publicClient = createPublicClient({ chain, transport, pollingInterval });
  // wallets send through the same ordered fallback
  const wallet = (account?: Account) => (account ? createWalletClient({ chain, transport, account, pollingInterval }) : undefined);
  return {
    chain,
    publicClient,
    relayer: wallet(loadHotKey("RELAYER", env)),
    keeper: wallet(loadHotKey("KEEPER", env)),
    resolver: wallet(loadHotKey("RESOLVER", env)),
    escrow: env.ESCROW_ADDRESS as Address | undefined,
    evaluator: env.EVALUATOR_ADDRESS as Address | undefined,
    resolverContract: env.RESOLVER_ADDRESS as Address | undefined,
    usdg: env.USDG_ADDRESS as Address,
  };
}

export type Clients = ReturnType<typeof makeClients>;

export function required<T>(v: T | undefined, name: string): T {
  if (v === undefined || v === null) throw new Error(`${name} is not configured`);
  return v;
}
