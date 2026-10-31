"use client";
import { useCallback, useEffect, useState } from "react";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { api, friendlyError, type EscrowView, type MineRow } from "@/lib/ifso/api";
import { escrowNonce, sendWithMargin } from "@/lib/ifso/chain";
import { resolveChainInfo, type ChainInfo } from "@/lib/ifso/chainInfo";
import { config, explorerTx } from "@/lib/ifso/config";
import { DecisionAction, decide, redirectRefund } from "@/lib/ifso/decisions";
import { escrowAbi } from "@/lib/ifso/escrowAbi";
import { FLAG, has, isOpen, KIND_TEXT, owedVoidSide, same, STATUS_TEXT, usdgText, when } from "@/lib/ifso/status";
import { shortAddress, signTyped } from "@/lib/ifso/wallet";
import { useWallet } from "./wallet-context";

export type PaymentsMode = "Sent" | "Received" | "Approvals" | "Refunds" | "Activity";

const unix = (v: string | null | undefined): number => {
  if (!v) return 0;
  return /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v);
};

export function PaymentsView({ mode, refreshKey }: { mode: PaymentsMode; refreshKey: number }) {
  const w = useWallet();
  const me = w.session?.address;
  const [now] = useState(() => Date.now());
  const [rows, setRows] = useState<MineRow[]>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!me) return;
    setError("");
    try {
      setRows(await api.mine({ address: me }));
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [me]);
  useEffect(() => {
    setRows(undefined);
    void load();
  }, [load, refreshKey]);

  if (!me)
    return (
      <section className="ws-ledger ws-card">
        <div className="ws-empty">
          <span>◌</span>
          <h2>Connect a wallet to see this.</h2>
          <p>Your payments are read from the chain through the IFSO service. Nothing is shown until you connect.</p>
          <button className="ws-button" onClick={w.openPicker}>
            CONNECT WALLET ↗
          </button>
        </div>
      </section>
    );

  const shown = (rows ?? []).filter((r) => {
    if (mode === "Sent") return same(r.sender, me);
    if (mode === "Received") return same(r.recipient, me);
    if (mode === "Approvals") return isOpen(r.status) && r.kind === 3;
    if (mode === "Refunds") return (same(r.sender, me) && isOpen(r.status)) || r.status === 5;
    return true;
  });
  const empty: Record<PaymentsMode, string> = {
    Sent: "You have not sent a payment from this wallet yet.",
    Received: "Nothing has been sent to this wallet yet.",
    Approvals: "No open payment is waiting for an approval from this wallet.",
    Refunds: "No payment from this wallet is waiting on a refund.",
    Activity: "No activity for this wallet yet.",
  };
  return (
    <>
      <section className="ws-ledger ws-card">
        <div className="ws-card-head">
          <h3>
            {mode} <small>({shown.length})</small>
          </h3>
          <button onClick={() => void load()}>Refresh ↻</button>
        </div>
        {error && <p className="wp-error">{error}</p>}
        {!rows && !error && <p className="ws-compose-note">Loading from the service…</p>}
        {rows && shown.length === 0 && <p className="ws-compose-note">{empty[mode]}</p>}
        {shown.map((r) => (
          <PaymentCard key={r.id} row={r} me={me} expired={unix(r.expiry) <= now} onChanged={load} />
        ))}
      </section>
      {mode === "Approvals" && <ByNumber />}
    </>
  );
}

function useChainInfo() {
  const [info, setInfo] = useState<ChainInfo>();
  const get = useCallback(async () => {
    if (info) return info;
    const i = await resolveChainInfo(api, config);
    setInfo(i);
    return i;
  }, [info]);
  return get;
}

/** A referee (or anyone with a payment number) opens it directly: the chain answers, the URL is not trusted. */
function ByNumber() {
  const me = useWallet().session?.address;
  const [id, setId] = useState("");
  const [view, setView] = useState<EscrowView>();
  const [msg, setMsg] = useState("");
  async function open() {
    setMsg("");
    setView(undefined);
    if (!/^\d+$/.test(id.trim())) return setMsg("A payment number is digits only.");
    try {
      setView(await api.escrow({ id: id.trim() }));
    } catch (e) {
      setMsg(friendlyError(e));
    }
  }
  return (
    <section className="ws-ledger ws-card">
      <div className="ws-card-head">
        <h3>Open a payment by number</h3>
      </div>
      <p className="ws-compose-note">A referee can open the payment they were named on here.</p>
      <div className="wp-inline">
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Payment number" inputMode="numeric" aria-label="Payment number" />
        <button className="ws-button" onClick={() => void open()}>
          OPEN ↗
        </button>
      </div>
      {msg && <p className="wp-error">{msg}</p>}
      {view && <Details id={id.trim()} view={view} me={me} onChanged={() => void open()} />}
    </section>
  );
}

function PaymentCard({ row, me, expired, onChanged }: { row: MineRow; me: Address; expired: boolean; onChanged: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<EscrowView>();
  const [err, setErr] = useState("");
  async function toggle() {
    setOpen(!open);
    if (!open && !view) {
      try {
        setView(await api.escrow({ id: row.id }));
      } catch (e) {
        setErr(friendlyError(e));
      }
    }
  }
  const counterparty = same(row.sender, me) ? (row.recipient ? shortAddress(row.recipient) : "claim link") : shortAddress(row.sender);
  return (
    <div className="wp-card">
      <div className="ws-entry">
        <span className="ws-dot" />
        <div>
          <b>{same(row.sender, me) ? `To ${counterparty}` : `From ${counterparty}`}</b>
          <small>
            {KIND_TEXT[row.kind] ?? "A condition"} · {STATUS_TEXT[row.status] ?? "Unknown"}
            {isOpen(row.status) && ` · expires ${when(unix(row.expiry))}`}
            {expired && isOpen(row.status) ? " (expired)" : ""}
          </small>
        </div>
        <strong>{usdgText(row.amount)}</strong>
        <button onClick={() => void toggle()}>{open ? "Hide ↑" : "Details ↓"}</button>
      </div>
      {open && (view ? <Details id={row.id} view={view} me={me} onChanged={async () => {
        setView(await api.escrow({ id: row.id }).catch(() => view));
        await onChanged();
      }} /> : <p className="ws-compose-note">{err || "Reading from the chain…"}</p>)}
    </div>
  );
}

function Details({ id, view, me, onChanged }: { id: string; view: EscrowView; me?: Address; onChanged: () => void | Promise<void> }) {
  const w = useWallet();
  const chain = useChainInfo();
  const e = view.escrow;
  const cond = view.condition as { kind?: number | string; mode?: number | string; target?: string };
  const [now] = useState(() => Date.now());
  const [msg, setMsg] = useState("");
  const [tx, setTx] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refundTo, setRefundTo] = useState("");
  const [alt, setAlt] = useState("");
  const expiryMs = unix(String(e.expiry));
  const expired = expiryMs <= now;
  const isSender = same(e.sender, me);
  const isRecipient = same(e.recipient, me);
  const isReferee = Number(cond.kind) === 3 && Number(cond.mode) === 1 && same(cond.target, me);
  const open = isOpen(e.status);
  const owed = me ? owedVoidSide({ status: e.status, flags: e.flags, sender: e.sender }, me, e.recipient) : undefined;

  async function run(label: string, fn: (s: NonNullable<typeof w.session>, i: ChainInfo) => Promise<string>) {
    if (!w.session) return w.openPicker();
    setBusy(true);
    setMsg("");
    try {
      const i = await chain();
      const hash = await fn(w.session, i);
      setTx(hash);
      setMsg(`${label}: sent.`);
      await onChanged();
    } catch (er) {
      setMsg(friendlyError(er));
    } finally {
      setBusy(false);
    }
  }
  const relay = (s: NonNullable<typeof w.session>, i: ChainInfo) => ({ api, chainId: i.chainId, escrow: i.escrow, signer: s.address, sign: (t: Parameters<typeof signTyped>[1]) => signTyped(s, t), nonce: (o: Address) => escrowNonce(i.escrow, o) });
  const approveParty = Number(cond.kind) === 3 && Number(cond.mode) === 0 && open && (isSender || isRecipient);
  const myOk = (isSender && has(e.flags, FLAG.senderOk)) || (isRecipient && has(e.flags, FLAG.recipientOk));

  return (
    <div className="wp-details">
      <dl>
        <dt>Amount</dt>
        <dd>{view.amountText} USDG</dd>
        <dt>Status</dt>
        <dd>{STATUS_TEXT[e.status] ?? e.status}</dd>
        <dt>Sender</dt>
        <dd>{e.sender}</dd>
        <dt>Recipient</dt>
        <dd>{same(e.recipient, zeroAddress) ? "Whoever opens the claim link" : e.recipient}</dd>
        <dt>Expires</dt>
        <dd>{when(expiryMs)}</dd>
        {has(e.flags, FLAG.twoSided) && (
          <>
            <dt>Challenge</dt>
            <dd>{has(e.flags, FLAG.accepted) ? "Accepted" : `Waiting for the other side until ${when(unix(String(e.acceptBy)))}`}</dd>
          </>
        )}
      </dl>

      {approveParty && !myOk && (
        <div className="wp-actions">
          <button className="ws-button" disabled={busy} onClick={() => void run("Approval", (s, i) => decide(relay(s, i), id, DecisionAction.OK))}>
            I APPROVE
          </button>
          <button className="ws-button wp-ghost" disabled={busy} onClick={() => void run("Decline", (s, i) => decide(relay(s, i), id, DecisionAction.DECLINE))}>
            DECLINE
          </button>
        </div>
      )}
      {approveParty && myOk && <p className="ws-compose-note">Your approval is recorded. Waiting for the other person.</p>}
      {isReferee && open && (
        <div className="wp-actions">
          <button className="ws-button" disabled={busy} onClick={() => void run("Release", (s, i) => decide(relay(s, i), id, DecisionAction.REFEREE_RELEASE))}>
            RELEASE TO THE RECIPIENT
          </button>
          <button className="ws-button wp-ghost" disabled={busy} onClick={() => void run("Return", (s, i) => decide(relay(s, i), id, DecisionAction.REFEREE_RETURN))}>
            RETURN TO THE SENDER
          </button>
        </div>
      )}
      {open && expired && (
        <div className="wp-actions">
          <button className="ws-button" disabled={busy} onClick={() => void run("Refund", async (s, i) => sendWithMargin(s, { address: i.escrow, abi: escrowAbi, functionName: "refund", args: [BigInt(id), false, false] }))}>
            SEND IT BACK TO THE SENDER
          </button>
          <p className="ws-compose-note">It has expired, so anyone can do this. The money goes to the sender&apos;s refund address, paid by your wallet&apos;s network fee.</p>
        </div>
      )}
      {open && !expired && isSender && has(e.flags, FLAG.cancellable) && !has(e.flags, FLAG.accepted) && (
        <div className="wp-actions">
          <button className="ws-button wp-ghost" disabled={busy} onClick={() => void run("Cancel", (s, i) => sendWithMargin(s, { address: i.escrow, abi: escrowAbi, functionName: "cancel", args: [BigInt(id)] }))}>
            CANCEL THIS PAYMENT
          </button>
        </div>
      )}
      {open && isSender && (
        <details className="wp-redirect">
          <summary>Change where a refund goes</summary>
          <p className="ws-compose-note">Now: {e.refundTo === zeroAddress ? "back to your wallet" : e.refundTo}. You sign; the service pays the network fee.</p>
          <input value={refundTo} onChange={(ev) => setRefundTo(ev.target.value)} placeholder="New refund address (0x…)" spellCheck={false} aria-label="New refund address" />
          <input value={alt} onChange={(ev) => setAlt(ev.target.value)} placeholder="Backup address (optional)" spellCheck={false} aria-label="Backup refund address" />
          <button
            className="ws-button"
            disabled={busy || !isAddress(refundTo) || (alt !== "" && !isAddress(alt))}
            onClick={() => void run("Refund address", (s, i) => redirectRefund(relay(s, i), id, getAddress(refundTo), alt ? getAddress(alt) : zeroAddress))}
          >
            SIGN & SAVE ↗
          </button>
        </details>
      )}
      {owed && (
        <div className="wp-actions">
          <p className="ws-compose-note">This challenge was voided and your amount is still waiting to be sent back. The service usually does it for you; you can also do it now.</p>
          <button className="ws-button" disabled={busy} onClick={() => void run("Claim", (s, i) => sendWithMargin(s, { address: i.escrow, abi: escrowAbi, functionName: "claimVoid", args: [BigInt(id), owed === "counter", false] }))}>
            CLAIM MY AMOUNT BACK
          </button>
        </div>
      )}
      {msg && <p className="ws-compose-note" role="status">{msg}</p>}
      {tx && explorerTx(tx) && (
        <a className="ws-compose-back" href={explorerTx(tx)} target="_blank" rel="noopener noreferrer">
          View the transaction ↗
        </a>
      )}
    </div>
  );
}
