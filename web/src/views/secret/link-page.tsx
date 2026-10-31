"use client";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { createWalletClient, custom } from "viem";
import { linkWalletMessage } from "@/vendor/ifso/client";
import { FRAGMENT_STASH_VAR } from "@/lib/ifso/csp";
import { api, friendlyError } from "@/lib/ifso/api";
import { shortAddress, type DiscoveredWallet } from "@/lib/ifso/wallet";
import { pickAddress, WalletList } from "./secret-wallets";

/** The token in the address bar is one-time and valid 15 minutes. Read it, then remove it from the bar and history. */
let tokenOnce: string | undefined | null = null;
function takeToken(): string | undefined {
  if (tokenOnce !== null) return tokenOnce;
  const w = window as unknown as Record<string, unknown>;
  const stashed = typeof w[FRAGMENT_STASH_VAR] === "string" ? (w[FRAGMENT_STASH_VAR] as string) : undefined;
  delete w[FRAGMENT_STASH_VAR];
  const raw = (stashed ?? window.location.hash).replace(/^#/, "");
  tokenOnce = /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : undefined;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return tokenOnce;
}
// at load, before render and before any request
const initial: string | undefined | null = typeof window !== "undefined" ? takeToken() : null;

export function LinkPage() {
  const [token, setToken] = useState<string | undefined | null>(null);
  const [wallet, setWallet] = useState<{ w: DiscoveredWallet; address: Address }>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => setToken(initial ?? takeToken()), []);

  async function pick(w: DiscoveredWallet) {
    setBusy(true);
    setMsg("");
    try {
      setWallet({ w, address: await pickAddress(w) });
    } catch (e) {
      setMsg(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  async function link() {
    if (!wallet || !token) return;
    setBusy(true);
    setMsg("");
    try {
      const client = createWalletClient({ account: wallet.address, transport: custom(wallet.w.provider as never) });
      const signature = await client.signMessage({ account: wallet.address, message: linkWalletMessage(token) });
      await api.linkWallet({ token, address: wallet.address, signature });
      setDone(true);
    } catch (e) {
      const text = friendlyError(e);
      setMsg(/expired|used/i.test(text) ? "This link has expired or was already used. Send /link to the bot again to get a new one." : text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="sx-brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/favicon-32x32.png" alt="" width={32} height={32} />
        <span>IFSO</span>
      </div>
      <div className="sx-card">
        {token === null ? (
          <p>Opening your link…</p>
        ) : !token ? (
          <>
            <h1>This link does not work.</h1>
            <p>Send /link to the IFSO bot in a private chat and tap the button it sends you. The link works once and lasts 15 minutes.</p>
          </>
        ) : done ? (
          <>
            <h1>Wallet linked.</h1>
            <p>{shortAddress(wallet?.address ?? "0x0000")} is now connected to your Telegram account. You can go back to the chat.</p>
          </>
        ) : (
          <>
            <h1>Link your wallet.</h1>
            <p className="sx-soft">This connects one wallet to your Telegram account so the bot can tell you when your payments change. It costs nothing and moves no money.</p>
            {wallet ? (
              <>
                <div className="sx-addr">{wallet.address}</div>
                <h2>You will sign this text</h2>
                <pre className="sx-addr">{linkWalletMessage(token)}</pre>
                <button className="sx-btn" disabled={busy} onClick={() => void link()}>
                  {busy ? "Waiting for your wallet…" : "SIGN & LINK"}
                </button>
                <button className="sx-btn sx-ghost" onClick={() => setWallet(undefined)}>
                  Use a different wallet
                </button>
              </>
            ) : (
              <WalletList busy={busy} onPick={(w) => void pick(w)} />
            )}
            {msg && <p className="sx-error" role="status">{msg}</p>}
          </>
        )}
      </div>
    </>
  );
}
