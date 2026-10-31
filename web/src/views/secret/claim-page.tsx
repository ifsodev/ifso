"use client";
import { useEffect, useState } from "react";
import { createWalletClient, custom, getAddress, zeroAddress, type Address, type Hex } from "viem";
import { acceptAuthorizationTypedData, runClaim, signAccept } from "@/vendor/ifso/client";
import { api, friendlyError, type EscrowView } from "@/lib/ifso/api";
import { resolveChainInfo, type ChainInfo } from "@/lib/ifso/chainInfo";
import { takeClaimLink, type ClaimLink } from "@/lib/ifso/claimLink";
import { config, explorerTx } from "@/lib/ifso/config";
import { describeOnChainCondition } from "@/lib/ifso/describe";
import { FLAG, has, owedVoidSide, same, STATUS_TEXT, when } from "@/lib/ifso/status";
import { shortAddress, type DiscoveredWallet } from "@/lib/ifso/wallet";
import { pickAddress, WalletList } from "./secret-wallets";
import { createPasskeyAccount, loadSavedPasskey } from "./passkey";

// Runs when this chunk loads in the browser: the secret is out of the address bar before anything renders or is fetched.
const initial: ClaimLink | undefined = typeof window !== "undefined" ? takeClaimLink() : undefined;

const RISK =
  "Before you claim: this payment was made by someone else and IFSO has not been through an external audit yet. Anyone who holds this link can claim it, so do not share it. If it is not claimed before it expires, it goes back to the sender.";

type Recipient = { address: Address; via: "wallet" | "passkey"; label: string };

export function ClaimPage() {
  const [link, setLink] = useState<ClaimLink>();
  const [info, setInfo] = useState<ChainInfo>();
  const [view, setView] = useState<EscrowView>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const l = initial ?? takeClaimLink();
    setLink(l);
    if (!l.ok) return setLoading(false);
    (async () => {
      try {
        const ci = await resolveChainInfo(api, config);
        setInfo(ci);
        // amount, status and condition come from the chain (through the API), never from the link text
        setView(await api.escrow({ id: l.id.toString() }));
      } catch (e) {
        setError(friendlyError(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <>
      <div className="sx-brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/favicon-32x32.png" alt="" width={32} height={32} />
        <span>IFSO</span>
      </div>
      <div className="sx-card">
        {!link || loading ? (
          <p>Opening your link…</p>
        ) : !link.ok ? (
          <>
            <h1>This link does not work.</h1>
            <p>It may have been cut short when it was copied. Open the original message and tap the link again.</p>
          </>
        ) : error ? (
          <>
            <h1>We could not read this payment.</h1>
            <p className="sx-error">{error}</p>
            <p className="sx-soft">Nothing was claimed. Open the link from your message again to retry.</p>
          </>
        ) : view && info ? (
          <Claim link={link} info={info} view={view} reload={async () => setView(await api.escrow({ id: link.id.toString() }))} />
        ) : null}
      </div>
    </>
  );
}

function Summary({ view }: { view: EscrowView }) {
  const e = view.escrow;
  return (
    <>
      <p className="sx-label">Read from the chain</p>
      <p className="sx-amount">{view.amountText} USDG</p>
      <p>{describeOnChainCondition(view.condition)}</p>
      <div className="sx-row">
        <span>From</span>
        <span>{shortAddress(e.sender)}</span>
      </div>
      <div className="sx-row">
        <span>Expires</span>
        <span>{when(Number(e.expiry) * 1000)}</span>
      </div>
      <div className="sx-row">
        <span>Status</span>
        <span>{STATUS_TEXT[e.status] ?? e.status}</span>
      </div>
    </>
  );
}

function Claim({ link, info, view, reload }: { link: Extract<ClaimLink, { ok: true }>; info: ChainInfo; view: EscrowView; reload: () => Promise<void> }) {
  const e = view.escrow;
  const [nowMs] = useState(() => Date.now());
  const now = nowMs / 1000;
  const twoSided = has(e.flags, FLAG.twoSided);
  const [recipient, setRecipient] = useState<Recipient>();
  const [saved, setSaved] = useState<ReturnType<typeof loadSavedPasskey>>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState(false);
  const [done, setDone] = useState<{ status: "bound" | "paid"; txHash: Hex }>();
  const [acceptor, setAcceptor] = useState<{ w: DiscoveredWallet; address: Address }>();
  useEffect(() => setSaved(loadSavedPasskey()), []);

  const open = e.status === 1 || e.status === 2;
  const bound = !same(e.recipient, zeroAddress);
  const expired = now >= Number(e.expiry);

  async function pickWallet(w: DiscoveredWallet) {
    setBusy(true);
    setMsg("");
    try {
      const address = await pickAddress(w);
      setRecipient({ address, via: "wallet", label: w.info.name });
      setAcceptor({ w, address });
    } catch (er) {
      setMsg(friendlyError(er));
    } finally {
      setBusy(false);
    }
  }
  async function makePasskey() {
    setBusy(true);
    setMsg("");
    try {
      const p = await createPasskeyAccount();
      setSaved(p);
      setRecipient({ address: p.address, via: "passkey", label: "Passkey account" });
    } catch (er) {
      setMsg(friendlyError(er));
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    if (!recipient || !ok) return;
    setBusy(true);
    setMsg("");
    try {
      // runClaim zeroes the secret it is given once it has signed; hand it a copy so a failed relay can be retried
      const r = await runClaim(
        {
          chainId: info.chainId,
          escrow: info.escrow,
          getEscrow: (id) => api.escrow({ id }) as never,
          relayClaim: (i) => api.claim(i),
          getRecipientAddress: async () => recipient.address,
        },
        { id: link.id, secret: link.secret.slice() },
      );
      link.secret.fill(0);
      setDone(r);
      await reload().catch(() => {});
    } catch (er) {
      setMsg(friendlyError(er));
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!acceptor) return;
    setBusy(true);
    setMsg("");
    try {
      const a = acceptor.address;
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const validAfter = nowSec - 60n;
      const validBefore = nowSec + 3600n;
      const counterAmount = BigInt(e.counterAmount);
      const hasLink = !same(e.linkKey, zeroAddress);
      const linkSig: Hex = hasLink ? await signAccept({ secret: link.secret.slice(), chainId: info.chainId, escrow: info.escrow, id: link.id, acceptor: a, conditionHash: e.conditionHash }) : "0x";
      const typed = acceptAuthorizationTypedData({ chainId: info.chainId, usdg: info.usdg, escrow: info.escrow, id: link.id, acceptor: a, counterRefundTo: a, counterAmount, validAfter, validBefore });
      const authSig = await createWalletClient({ account: a, transport: custom(acceptor.w.provider as never) }).signTypedData(typed as never);
      const r = await api.accept({ id: link.id.toString(), acceptor: a, linkSig, counterRefundTo: a, validAfter: validAfter.toString(), validBefore: validBefore.toString(), authSig });
      link.secret.fill(0);
      setDone({ status: "paid", txHash: r.txHash });
      await reload().catch(() => {});
    } catch (er) {
      setMsg(friendlyError(er));
    } finally {
      setBusy(false);
    }
  }

  // ---- finished states
  if (done) {
    const url = explorerTx(done.txHash);
    return (
      <>
        <h1>{twoSided ? "You joined the challenge." : done.status === "paid" ? "It is on its way to you." : "It is locked to you."}</h1>
        <p>
          {twoSided
            ? "Your amount is now locked with theirs. Whoever the condition favours is paid when it happens; if it cannot be decided, each side gets its own amount back."
            : done.status === "paid"
              ? `${view.amountText} USDG was sent to ${recipient ? shortAddress(recipient.address) : "your address"}.`
              : `You will receive ${view.amountText} USDG at ${recipient ? shortAddress(recipient.address) : "your address"} as soon as the condition happens. Nobody else can claim it now.`}
        </p>
        {recipient?.via === "passkey" && <p className="sx-msg">Your passkey account is {recipient.address}. Write this address down. It is controlled by the passkey on this device; if you lose the passkey you lose access, the same as losing a wallet.</p>}
        {url && (
          <a className="sx-btn sx-ghost" href={url} target="_blank" rel="noopener noreferrer">
            View the transaction
          </a>
        )}
      </>
    );
  }

  const owed = owedVoidSide({ status: e.status, flags: e.flags, sender: e.sender }, acceptor?.address ?? "", e.recipient);
  if (e.status === 5 || (!open && twoSided)) {
    return (
      <>
        <h1>This challenge is closed.</h1>
        <Summary view={view} />
        <p>{e.status === 5 ? "It could not be decided, so each side gets its own amount back." : "It has finished."}</p>
        {(has(e.flags, FLAG.senderOwed) || has(e.flags, FLAG.counterOwed)) && <ClaimVoidHint />}
        {owed && <p className="sx-msg">Your amount is still waiting to be sent back. Open the IFSO dashboard with this wallet to claim it.</p>}
      </>
    );
  }
  if (!twoSided && (!open || bound || expired)) {
    return (
      <>
        <h1>{expired && open ? "This link has expired." : "This payment is not waiting to be claimed."}</h1>
        <Summary view={view} />
        <p className="sx-soft">{bound ? "It has already been claimed." : expired && open ? "The money can be sent back to the sender by anyone." : "It has finished."}</p>
      </>
    );
  }

  if (twoSided) {
    const acceptable = open && !expired && !has(e.flags, FLAG.accepted) && now < Number(e.acceptBy);
    return (
      <>
        <h1>You are invited to a challenge.</h1>
        <p className="sx-soft">To join, you put in {(Number(e.counterAmount) / 1e6).toFixed(2)} USDG. Both amounts are locked until the condition is decided.</p>
        <Summary view={view} />
        {!acceptable ? (
          <p className="sx-msg">{has(e.flags, FLAG.accepted) ? "Someone has already joined this challenge." : "The time to join has passed."}</p>
        ) : (
          <>
            <p className="sx-risk">{RISK}</p>
            <h2>Join with a wallet</h2>
            <p className="sx-soft">You sign two things in your wallet: your amount, and a note that you are the one joining. You need USDG, not ETH.</p>
            {acceptor ? <div className="sx-addr">{acceptor.address}</div> : <WalletList busy={busy} onPick={(w) => void pickWallet(w)} />}
            <label className="sx-check">
              <input type="checkbox" checked={ok} onChange={(ev) => setOk(ev.target.checked)} />
              <span>I have read this and want to join.</span>
            </label>
            <button className="sx-btn" disabled={busy || !acceptor || !ok} onClick={() => void accept()}>
              {busy ? "Waiting for your wallet…" : "JOIN THE CHALLENGE"}
            </button>
          </>
        )}
        {msg && <p className="sx-error" role="status">{msg}</p>}
      </>
    );
  }

  return (
    <>
      <h1>Someone sent you money.</h1>
      <Summary view={view} />
      <p className="sx-risk">{RISK}</p>
      <h2>Where should it go?</h2>
      {recipient ? (
        <>
          <p className="sx-soft">It will be sent to this address ({recipient.label}). Check it, this cannot be changed after you claim.</p>
          <div className="sx-addr">{recipient.address}</div>
          <button type="button" className="sx-btn sx-ghost" onClick={() => setRecipient(undefined)}>
            Use a different address
          </button>
        </>
      ) : (
        <>
          <p className="sx-soft">Pick a wallet you already use, or make a passkey account on this device. The passkey account needs no app, no seed phrase and no fee.</p>
          <WalletList busy={busy} onPick={(w) => void pickWallet(w)} />
          {saved && (
            <button type="button" className="sx-btn sx-ghost" onClick={() => setRecipient({ address: getAddress(saved.address), via: "passkey", label: "Passkey account saved on this device" })}>
              Use my passkey account {shortAddress(saved.address)}
            </button>
          )}
          <button type="button" className="sx-btn sx-ghost" disabled={busy} onClick={() => void makePasskey()}>
            Make a passkey account
          </button>
        </>
      )}
      <label className="sx-check">
        <input type="checkbox" checked={ok} onChange={(ev) => setOk(ev.target.checked)} />
        <span>I have read this and want to claim it.</span>
      </label>
      <button className="sx-btn" disabled={busy || !recipient || !ok} onClick={() => void claim()}>
        {busy ? "Claiming…" : recipient ? `CLAIM ${view.amountText} USDG TO ${shortAddress(recipient.address)}` : "CHOOSE WHERE IT GOES"}
      </button>
      {msg && (
        <p className="sx-error" role="status">
          {msg}
        </p>
      )}
      <p className="sx-soft">Do not reload this page before you claim: the address bar no longer holds the link. If you do, open the link from your message again.</p>
    </>
  );
}

function ClaimVoidHint() {
  return <p className="sx-msg">The service sends owed amounts back automatically. If one is still waiting, the wallet that put it in can claim it from the IFSO dashboard.</p>;
}
