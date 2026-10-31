/**
 * Browser wallets. Two sources, both give an EIP-1193 provider:
 *  - the EIP-6963 list of installed wallets (always available, never a single generic "window.ethereum" button), and
 *  - Reown AppKit (WalletConnect) when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set (see ./appkit.ts).
 * Neither is loaded on the claim and link pages.
 */
import { createWalletClient, custom, getAddress, type Address, type Hex, type WalletClient } from "viem";
import { CHAIN_PROFILES, config, type ChainProfile } from "./config";

export interface Eip1193 {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, handler: (...a: unknown[]) => void): void;
  removeListener?(event: string, handler: (...a: unknown[]) => void): void;
}
export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}
export interface DiscoveredWallet {
  info: WalletInfo;
  provider: Eip1193;
}

/** Collects `eip6963:announceProvider` events. Returns an unsubscribe. `onChange` gets the full list each time. */
export function discoverWallets(onChange: (list: DiscoveredWallet[]) => void, target: Window = window): () => void {
  const seen = new Map<string, DiscoveredWallet>();
  const handler = (event: Event) => {
    const d = (event as CustomEvent<DiscoveredWallet>).detail;
    if (!d?.info?.uuid || !d.provider) return;
    seen.set(d.info.uuid, d);
    onChange([...seen.values()]);
  };
  target.addEventListener("eip6963:announceProvider", handler);
  target.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => target.removeEventListener("eip6963:announceProvider", handler);
}

export interface WalletSession {
  address: Address;
  chainId: number;
  label: string;
  provider: Eip1193;
  client: WalletClient;
  disconnect(): Promise<void>;
}

const hexChain = (id: number) => `0x${id.toString(16)}`;

/** Asks the wallet to move to our chain, adding it first when the wallet does not know it. */
export async function ensureChain(provider: Eip1193, profile: ChainProfile = config.chain): Promise<void> {
  const current = Number(await provider.request({ method: "eth_chainId" }));
  if (current === profile.id) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChain(profile.id) }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902 && code !== -32603) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hexChain(profile.id), chainName: profile.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [profile.rpcUrl], blockExplorerUrls: profile.explorerUrl ? [profile.explorerUrl] : [] }],
    });
  }
}

export async function sessionFromProvider(provider: Eip1193, label: string, disconnect: () => Promise<void> = async () => {}, profile: ChainProfile = config.chain): Promise<WalletSession> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.[0]) throw new Error("No account was selected in the wallet.");
  await ensureChain(provider, profile);
  const address = getAddress(accounts[0]);
  const client = createWalletClient({ account: address, transport: custom(provider as never) });
  return { address, chainId: profile.id, label, provider, client, disconnect };
}

export const connectInjected = (w: DiscoveredWallet) => sessionFromProvider(w.provider, w.info.name);

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Signs EIP-712 typed data exactly as returned by the API (the caller has already verified it). */
export async function signTyped(session: WalletSession, typed: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<Hex> {
  return session.client.signTypedData({ account: session.address, ...typed } as never);
}

export { CHAIN_PROFILES };
