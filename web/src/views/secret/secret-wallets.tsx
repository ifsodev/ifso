"use client";
/** Wallet list for the secret pages: only what the browser announces (EIP-6963). No WalletConnect, no remote code. */
import { useEffect, useState } from "react";
import { getAddress, type Address } from "viem";
import { discoverWallets, type DiscoveredWallet } from "@/lib/ifso/wallet";

export function useInjectedWallets() {
  const [list, setList] = useState<DiscoveredWallet[]>([]);
  useEffect(() => discoverWallets(setList), []);
  return list;
}

/** Asks one wallet for an account. Does not switch network: claiming only needs the address. */
export async function pickAddress(w: DiscoveredWallet): Promise<Address> {
  const accounts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.[0]) throw new Error("No account was selected in the wallet.");
  return getAddress(accounts[0]);
}

export function WalletList({ onPick, busy }: { onPick: (w: DiscoveredWallet) => void; busy?: boolean }) {
  const list = useInjectedWallets();
  if (!list.length) return <p className="sx-soft">No browser wallet was found. Install a wallet extension, open this page inside your wallet app, or make a passkey account instead.</p>;
  return (
    <ul className="sx-wallets">
      {list.map((w) => (
        <li key={w.info.uuid}>
          <button type="button" disabled={busy} onClick={() => onPick(w)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={w.info.icon} alt="" width={32} height={32} />
            <span>{w.info.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
