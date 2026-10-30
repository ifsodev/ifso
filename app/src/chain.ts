// viem clients for Robinhood Chain. Three separate hot keys, each funded with a little ETH only:
//  relayer  - submits claims, gasless creates/accepts, decisions, refund redirects (cannot redirect funds)
//  keeper   - settle + refund sweeps (permissionless calls)
//  resolver - registers questions, proposes outcomes with USDG bonds, disputes, finalizes
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rhc, rhcTestnet } from "./config/chain";
import type { Env } from "./config/env";

export function chainFor(env: Env) {
  return env.CHAIN_ID === 46630 ? rhcTestnet : rhc;
}

export function makeClients(env: Env) {
  const chain = chainFor(env);
  const transport = http(env.RHC_RPC_URL, { batch: true, retryCount: 3 });
  const publicClient = createPublicClient({ chain, transport });
  const wallet = (pk?: string) =>
    pk ? createWalletClient({ chain, transport, account: privateKeyToAccount(pk as Hex) }) : undefined;
  return {
    chain,
    publicClient,
    relayer: wallet(env.RELAYER_PK),
    keeper: wallet(env.KEEPER_PK),
    resolver: wallet(env.RESOLVER_PK),
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
