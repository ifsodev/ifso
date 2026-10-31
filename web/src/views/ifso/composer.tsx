"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { api, friendlyError, type BuildAnswer, type GeoAnswer, type ParseResult } from "@/lib/ifso/api";
import { resolveChainInfo, type ChainInfo } from "@/lib/ifso/chainInfo";
import { config, explorerTx } from "@/lib/ifso/config";
import { buildAndVerify, signAndSubmit, type CreateResult } from "@/lib/ifso/create";
import { applyOption } from "@/lib/ifso/questions";
import { commandText, isAddressLike, KINDS } from "@/lib/ifso/text";
import { signTyped } from "@/lib/ifso/wallet";
import { useWallet } from "./wallet-context";
import { ShareSheet } from "./share-sheet";

export type PaymentDraft = { id: string; amount: string; recipient: string; kind: string; detail: string; expiry?: string; cancel: boolean; saved: string; challenge?: boolean; counter?: string };
export const RISK_NOTE =
  "Before you sign: IFSO has not been through an external audit yet. The token issuer can freeze balances. Price conditions follow a market data feed that can lag. Match and market results depend on a resolver with a dispute window. A payment cannot be pulled back once it is locked, but anyone can send it back to you after it expires. Each payment is limited to 1,000 USDG during the launch period.";

export function PaymentComposer({ draft, onSave, onCancel, onCreated }: { draft?: PaymentDraft; onSave: (d: PaymentDraft) => void; onCancel: () => void; onCreated: () => void }) {
  const wallet = useWallet();
  const [kind, setKind] = useState(draft?.kind || "date");
  const [v, setV] = useState({ amount: draft?.amount || "", recipient: draft?.recipient || "", detail: draft?.detail || "", cancel: draft?.cancel || false, challenge: draft?.challenge || false, counter: draft?.counter || "" });
  const [pinned, setPinned] = useState<string>(); // text after a question was answered
  const [parsed, setParsed] = useState<ParseResult>();
  const [geo, setGeo] = useState<GeoAnswer>();
  const [step, setStep] = useState<"details" | "review" | "done">("details");
  const [info, setInfo] = useState<ChainInfo>();
  const [built, setBuilt] = useState<{ answer: BuildAnswer; secret?: Uint8Array }>();
  const [result, setResult] = useState<CreateResult>();
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  const [agreed, setAgreed] = useState(false);

  const fields = { kind, amount: v.amount, recipient: v.recipient, detail: v.detail, challenge: v.challenge, counter: v.counter };
  const ready = v.amount.trim() !== "" && v.detail.trim().length >= 2;
  const text = useMemo(() => pinned ?? (ready ? commandText(fields) : ""), [pinned, ready, kind, v.amount, v.recipient, v.detail, v.challenge, v.counter]); // eslint-disable-line react-hooks/exhaustive-deps
  const tz = -new Date().getTimezoneOffset();

  useEffect(() => {
    api.geo().then(setGeo).catch(() => setGeo(undefined));
  }, []);

  // live preview from the service, debounced; stale answers are dropped
  const seq = useRef(0);
  useEffect(() => {
    if (!text || text.length < 3) {
      setParsed(undefined);
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(() => {
      api
        .parse({ text, tzOffsetMin: tz })
        .then((r) => n === seq.current && setParsed(r))
        .catch((e) => n === seq.current && setNote(friendlyError(e)));
    }, 350);
    return () => clearTimeout(t);
  }, [text, tz]);

  const edit = (patch: Partial<typeof v>) => {
    setPinned(undefined);
    setV({ ...v, ...patch });
  };
  const recipientOk = v.recipient.trim() === "" || isAddressLike(v.recipient);
  const open = parsed && parsed.questions.length === 0 && parsed.errors.length === 0 && parsed.ok;
  const stockBlocked = kind === "price" && geo && !geo.stockPriceConditionsAllowed;

  function saveDraft() {
    try {
      onSave({ ...v, kind, detail: v.detail, id: draft?.id || crypto.randomUUID(), saved: new Date().toISOString() });
      setNote("Draft saved on this browser. No payment has been created.");
    } catch {
      setNote("This browser could not save the draft.");
    }
  }

  async function review() {
    if (!wallet.session) return wallet.openPicker();
    if (!open || !recipientOk) return;
    setWorking(true);
    setNote("");
    try {
      const ci = info ?? (await resolveChainInfo(api, config));
      setInfo(ci);
      const b = await buildAndVerify({ api, chainId: ci.chainId, escrow: ci.escrow, usdg: ci.usdg, origin: location.origin }, { text, sender: wallet.session.address, recipient: isAddressLike(v.recipient) ? (v.recipient.trim() as Address) : undefined, cancellable: v.cancel, tzOffsetMin: tz });
      setBuilt(b);
      setAgreed(false);
      setStep("review");
    } catch (e) {
      setNote(friendlyError(e));
    } finally {
      setWorking(false);
    }
  }

  async function send() {
    if (!wallet.session || !built || !info) return;
    setWorking(true);
    setNote("");
    try {
      const s = wallet.session;
      const r = await signAndSubmit(
        { api, chainId: info.chainId, escrow: info.escrow, usdg: info.usdg, origin: location.origin, sign: (t) => signTyped(s, t) },
        { text, sender: s.address, recipient: isAddressLike(v.recipient) ? (v.recipient.trim() as Address) : undefined, cancellable: v.cancel, tzOffsetMin: tz },
        built,
      );
      setResult(r);
      setStep("done");
      onCreated();
    } catch (e) {
      setNote(friendlyError(e));
    } finally {
      setWorking(false);
    }
  }

  const a = built?.answer;
  const total = a ? (Number(a.total) / 1e6).toFixed(2) : "";

  return (
    <section className="ws-compose">
      <div className="ws-compose-intro">
        <p className="ws-label">01 / YOUR PAYMENT</p>
        <h1>
          Write your
          <br />
          <i>if into being.</i>
        </h1>
        <p>Set the amount, the condition and the moment. The service reads it back to you in plain words before anything is signed.</p>
        <div className="ws-compose-steps">
          <span>01 / DETAILS</span>
          <span>02 / REVIEW</span>
          <span>03 / SIGN & SHARE</span>
        </div>
        <p className="ws-compose-note">Drafts stay on this browser and do not move money. A payment is created only when you sign the review.</p>
      </div>
      <div className="ws-compose-paper">
        {step === "details" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void review();
            }}
          >
            <p className="ws-label">THE DETAILS</p>
            <label>
              Amount <span>USDG</span>
              <input required type="number" min="1" step="0.01" inputMode="decimal" value={v.amount} onChange={(e) => edit({ amount: e.target.value })} placeholder="0.00" />
            </label>
            <label>
              Recipient <span>ADDRESS, OR BLANK FOR A CLAIM LINK</span>
              <input value={v.recipient} onChange={(e) => edit({ recipient: e.target.value })} placeholder="0x… or leave blank" autoComplete="off" spellCheck={false} />
            </label>
            {!recipientOk && <p className="ws-compose-note">That is not a full wallet address. Leave it blank to get a claim link instead.</p>}
            <label>
              Unlock when <span>CONDITION</span>
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setPinned(undefined);
                }}
              >
                {KINDS.map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {stockBlocked && <p className="ws-compose-note">Stock price conditions are not offered where you are. Crypto prices, dates, results and markets still are.</p>}
            <label>
              Condition details <span>THE MOMENT</span>
              <input required value={v.detail} onChange={(e) => edit({ detail: e.target.value })} placeholder={KINDS.find((k) => k[0] === kind)?.[2]} autoComplete="off" />
            </label>
            <label className="ws-compose-check">
              <input type="checkbox" checked={v.challenge} onChange={(e) => edit({ challenge: e.target.checked })} /> Make it a challenge: the other person chips in too
            </label>
            {v.challenge && (
              <label>
                Their amount <span>USDG, BLANK = SAME</span>
                <input type="number" min="1" step="0.01" inputMode="decimal" value={v.counter} onChange={(e) => edit({ counter: e.target.value })} placeholder={v.amount || "0.00"} />
              </label>
            )}
            <label className="ws-compose-check">
              <input type="checkbox" checked={v.cancel} onChange={(e) => setV({ ...v, cancel: e.target.checked })} /> Allow cancellation before a decision
            </label>

            {text && (
              <div className="wp-preview" aria-live="polite">
                {parsed?.preview && <p className="wp-preview-text">{parsed.preview}</p>}
                {parsed?.notes.map((n) => (
                  <p className="ws-compose-note" key={n}>
                    {n}
                  </p>
                ))}
                {parsed?.errors.map((n) => (
                  <p className="wp-error" key={n}>
                    {n}
                  </p>
                ))}
                {parsed?.questions.map((q) => (
                  <div className="wp-question" key={q.kind + q.text}>
                    <p>{q.text}</p>
                    <div className="wp-options">
                      {q.options.map((o) => (
                        <button type="button" key={o.label} onClick={() => setPinned(applyOption(text, o))}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <p className="ws-compose-note">A locked payment cannot be pulled back. Every payment has an expiry and a refund path.</p>
            <button className="ws-button" disabled={working || !open || !recipientOk} type="submit">
              {wallet.session ? "REVIEW PAYMENT ↗" : "CONNECT WALLET TO REVIEW ↗"}
            </button>
            <button type="button" className="ws-compose-back" onClick={saveDraft} disabled={!v.amount || !v.detail}>
              Save as a draft
            </button>
            <button type="button" className="ws-compose-back" onClick={onCancel}>
              ← Back to dashboard
            </button>
          </form>
        )}

        {step === "review" && a && (
          <div>
            <p className="ws-label">02 / REVIEW</p>
            <h2>
              Look it <i>over.</i>
            </h2>
            {a.preview && <p className="wp-preview-text">{a.preview}</p>}
            {[
              ["Amount", `${(Number(a.total) / 1e6 - Number(a.fee) / 1e6).toFixed(2)} USDG`],
              ["Recipient", isAddressLike(v.recipient) ? v.recipient : "Whoever opens the claim link"],
              ["IFSO fee", a.feeText],
              ["Total you sign for", `${total} USDG`],
              ["Expiry", a.expiryText],
              ["Cancellation", v.cancel ? "Cancellable" : "Locked"],
            ].map(([label, value]) => (
              <div className="ws-review-row" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
            {a.notes.map((n) => (
              <p className="ws-compose-note" key={n}>
                {n}
              </p>
            ))}
            <p className="ws-compose-note wp-risk">{RISK_NOTE}</p>
            <label className="ws-compose-check">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> I have read this and want to sign.
            </label>
            <button className="ws-button" disabled={working || !agreed} onClick={() => void send()}>
              {working ? "WAITING FOR YOUR WALLET…" : "SIGN & SEND ↗"}
            </button>
            <button
              className="ws-compose-back"
              onClick={() => {
                setStep("details");
                setBuilt(undefined);
              }}
            >
              ← Edit details
            </button>
          </div>
        )}

        {step === "done" && result && (
          <ShareSheet result={result} txUrl={explorerTx(result.txHash)} onDone={onCancel} />
        )}
        <p role="status" className="ws-compose-note">
          {note}
        </p>
      </div>
    </section>
  );
}
