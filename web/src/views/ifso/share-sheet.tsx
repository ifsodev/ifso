"use client";
import { useState } from "react";
import type { CreateResult } from "@/lib/ifso/create";

/** After a create: the claim link (the only copy of the secret), with ways to send it. */
export function ShareSheet({ result, txUrl, onDone }: { result: CreateResult; txUrl?: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = result.claimUrl;
  const message = url ? `I sent you a payment on IFSO. Open this link to claim it: ${url}` : "";
  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  const canShare = typeof navigator !== "undefined" && "share" in navigator;
  return (
    <div>
      <p className="ws-label">03 / SIGNED & SENT</p>
      <h2>
        It is <i>on its way.</i>
      </h2>
      {url ? (
        <>
          <p className="ws-compose-note">This is the claim link. Send it only to the person it is for. Anyone who opens it before them can claim the payment.</p>
          <input className="wp-link" readOnly value={url} aria-label="Claim link" onFocus={(e) => e.currentTarget.select()} />
          <div className="wp-share">
            <button className="ws-button" onClick={() => void copy()}>
              {copied ? "COPIED" : "COPY LINK"}
            </button>
            {canShare && (
              <button className="ws-button" onClick={() => void navigator.share({ text: message }).catch(() => {})}>
                SHARE…
              </button>
            )}
            <a className="ws-button" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer">
              WHATSAPP
            </a>
            <a className="ws-button" href={`sms:?&body=${encodeURIComponent(message)}`}>
              TEXT MESSAGE
            </a>
          </div>
          <p className="ws-compose-note wp-risk">Keep a copy of this link now. It is not stored anywhere, and there is no way to get it back. If it is lost, the payment can only return to you after it expires.</p>
        </>
      ) : (
        <p className="ws-compose-note">The payment is locked for the address you chose. They can see it in their IFSO dashboard once the condition is met.</p>
      )}
      {txUrl && (
        <a className="ws-compose-back" href={txUrl} target="_blank" rel="noopener noreferrer">
          View the transaction ↗
        </a>
      )}
      <button className="ws-compose-back" onClick={onDone}>
        ← Back to dashboard
      </button>
    </div>
  );
}
