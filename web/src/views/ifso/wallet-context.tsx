"use client";
/**
 * One wallet session for the dashboard, and the picker that opens it.
 * With NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID the picker is Reown AppKit; without it, the list of wallets the browser
 * announces (EIP-6963), one button per wallet. Never a single generic "Connect" that grabs window.ethereum.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { friendlyError } from "@/lib/ifso/api";
import { config } from "@/lib/ifso/config";
import { connectInjected, discoverWallets, shortAddress, type DiscoveredWallet, type WalletSession } from "@/lib/ifso/wallet";

interface Ctx {
  session?: WalletSession;
  busy: boolean;
  status: string;
  openPicker(): void;
  disconnect(): Promise<void>;
  setStatus(s: string): void;
}
const WalletCtx = createContext<Ctx | undefined>(undefined);
export const useWallet = () => {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("useWallet needs <WalletProvider>");
  return c;
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<WalletSession>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);

  useEffect(() => discoverWallets(setWallets), []);
  // follow account and network changes made inside the wallet
  useEffect(() => {
    const p = session?.provider;
    if (!p?.on) return;
    const gone = () => setSession(undefined);
    p.on("accountsChanged", gone);
    p.on("chainChanged", gone);
    return () => {
      p.removeListener?.("accountsChanged", gone);
      p.removeListener?.("chainChanged", gone);
    };
  }, [session]);

  const finish = useCallback((s: WalletSession) => {
    setSession(s);
    setOpen(false);
    setStatus(`Connected: ${shortAddress(s.address)}.`);
  }, []);

  const pickInjected = useCallback(
    async (w: DiscoveredWallet) => {
      setBusy(true);
      try {
        finish(await connectInjected(w));
      } catch (e) {
        setStatus(friendlyError(e));
      } finally {
        setBusy(false);
      }
    },
    [finish],
  );

  const openPicker = useCallback(async () => {
    if (config.walletConnectProjectId) {
      setBusy(true);
      try {
        const { connectWithAppKit } = await import("@/lib/ifso/appkit");
        finish(await connectWithAppKit());
      } catch (e) {
        setStatus(friendlyError(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    setOpen(true);
  }, [finish]);

  const disconnect = useCallback(async () => {
    await session?.disconnect().catch(() => {});
    setSession(undefined);
    setStatus("Wallet disconnected.");
  }, [session]);

  const value = useMemo<Ctx>(() => ({ session, busy, status, openPicker: () => void openPicker(), disconnect, setStatus }), [session, busy, status, openPicker, disconnect]);

  return (
    <WalletCtx.Provider value={value}>
      {children}
      {open && (
        <div className="wp-backdrop" role="dialog" aria-modal="true" aria-label="Choose a wallet" onClick={() => setOpen(false)}>
          <div className="wp-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="wp-head">
              <h2>Choose a wallet</h2>
              <button type="button" className="wp-close" aria-label="Close" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            {wallets.length ? (
              <ul className="wp-list">
                {wallets.map((w) => (
                  <li key={w.info.uuid}>
                    <button type="button" disabled={busy} onClick={() => void pickInjected(w)}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={w.info.icon} alt="" width={32} height={32} />
                      <span>{w.info.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="wp-empty">No browser wallet was found. Install a wallet extension or open this page inside your wallet app, then try again.</p>
            )}
            <p className="wp-note">IFSO never sees your keys. You approve every signature in your wallet.</p>
          </div>
        </div>
      )}
    </WalletCtx.Provider>
  );
}
