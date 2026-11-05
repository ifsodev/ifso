"use client";
import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./dashboard.css";
import "./wired.css";
import { api, friendlyError, type MineRow, type PerksAnswer } from "@/lib/ifso/api";
import { same, when } from "@/lib/ifso/status";
import { subscribe, withOverlay } from "@/lib/ifso/optimistic";
import { shortAddress } from "@/lib/ifso/wallet";
import { offered } from "@/lib/ifso/features";
import { PaymentComposer, type PaymentDraft } from "./composer";
import { PaymentsView } from "./payments";
import { WalletProvider, useWallet } from "./wallet-context";

type Draft = PaymentDraft;
type View = "Create" | "Overview" | "Drafts" | "Sent" | "Received" | "Conditions" | "Approvals" | "Refunds" | "Activity" | "Guide" | "Settings";
const KEY = "ifso-payment-drafts-v1";
const estDay = (value: string | Date) => new Date(new Date(value).getTime() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
function readDrafts(): Draft[] {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
function writeDrafts(next: Draft[]) {
  localStorage.setItem(KEY, JSON.stringify(next));
}
const nav: View[] = ["Create", "Overview", "Drafts", "Sent", "Received", "Conditions", "Approvals", "Refunds", "Activity", "Guide", "Settings"];
const paths:Record<View,string>={
 Create:'M12 3 C11 8 12 15 12 21 M3 12 C8 11 16 12 21 11',
 Overview:'M18 5 C14 2 7 4 5 9 C1 16 7 21 13 20 C19 20 22 15 20 11 M8 12 C11 11 15 12 18 11',
 Drafts:'M6 4 C10 3 14 4 17 4 L20 8 L19 20 C15 19 10 20 6 20 Z M15 4 L15 8 L19 8 M9 12 C11 11 15 12 17 11 M9 16 C12 15 15 16 17 15',
 Sent:'M4 19 C9 15 14 10 19 5 M10 5 C13 5 17 5 20 4 L19 14',
 Received:'M20 5 C15 9 10 14 5 19 M14 19 L4 20 L5 10',
 Conditions:'M12 3 C15 7 18 9 21 12 C17 15 15 18 12 21 C9 18 6 15 3 12 C7 9 9 6 12 3 M9 12 L15 12',
 Approvals:'M4 12 C6 13 7 16 9 18 C13 12 17 8 21 5',
 Refunds:'M5 10 C5 5 10 3 14 4 C20 5 22 12 19 17 C17 21 10 22 6 18 M4 4 L4 10 L10 10',
 Activity:'M3 13 C5 13 6 12 8 13 L10 7 L13 19 L17 10 L19 13 L22 12',
 Guide:'M3 6 C7 4 10 5 12 7 C15 5 18 4 21 6 L20 19 C17 18 14 19 12 20 C9 18 6 18 4 19 Z M12 7 L12 20',
 Settings:'M12 6 C15 6 18 9 18 12 C18 16 15 18 12 18 C8 18 6 15 6 12 C6 8 9 6 12 6 M12 2 L12 4 M12 20 L12 22 M2 12 L4 12 M20 12 L22 12 M5 5 L7 7 M17 17 L19 19 M19 5 L17 7 M7 17 L5 19'
};
function NavIcon({ name }: { name: View }) {
  return (
    <svg className="ws-ink-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
      <path d="M3 21 l1 -.5 M21 3 l-1 .4" strokeWidth=".7" opacity=".55" />
    </svg>
  );
}

export function DashboardView() {
  return (
    <WalletProvider>
      <Dashboard />
    </WalletProvider>
  );
}

function Dashboard() {
  const wallet = useWallet();
  const account = wallet.session?.address;
  const [view, setView] = useState<View>("Overview");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | undefined>();
  const [currentTime, setCurrentTime] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [mineRows, setMine] = useState<MineRow[]>();
  const [perks, setPerks] = useState<PerksAnswer>();
  const [perksError, setPerksError] = useState("");

  useEffect(() => {
    setCurrentTime(Date.now());
    setDrafts(readDrafts());
    const params = new URLSearchParams(location.search);
    if (params.has("create") || params.has("draft")) {
      setView("Create");
      setEditing(params.get("draft") || undefined);
    }
  }, []);

  const [overlayTick, setOverlayTick] = useState(0);
  useEffect(() => subscribe(() => setOverlayTick((n) => n + 1)), []);
  const loadMine = useCallback(async () => {
    if (!account) return setMine(undefined);
    try {
      setMine(await api.mine({ address: account }));
    } catch {
      setMine(undefined);
    }
  }, [account]);
  useEffect(() => {
    void loadMine();
  }, [loadMine, refreshKey]);

  useEffect(() => {
    setPerks(undefined);
    setPerksError("");
    if (view !== "Settings" || !account) return;
    api.perks({ address: account }).then(setPerks).catch((e) => setPerksError(friendlyError(e)));
  }, [view, account]);

  function openView(next: View) {
    setView(next);
    history.replaceState(null, "", "/dashboard");
  }
  function openComposer(id?: string) {
    setEditing(id);
    setView("Create");
    history.replaceState(null, "", id ? `/dashboard?draft=${encodeURIComponent(id)}` : "/dashboard?create=1");
  }
  function saveDraft(draft: Draft) {
    const next = [draft, ...readDrafts().filter((item) => item.id !== draft.id)];
    writeDrafts(next);
    setDrafts(next);
  }
  function remove(id: string) {
    const next = drafts.filter((d) => d.id !== id);
    writeDrafts(next);
    setDrafts(next);
  }

  const groups = ["date", "price", "approval", "referee", "match", "market"];
  const distribution = groups.map((kind) => drafts.filter((d) => d.kind === kind).length);
  const draftDays = currentTime
    ? Array.from({ length: 7 }, (_, i) => {
        const day = new Date(currentTime - 5 * 60 * 60 * 1000);
        day.setUTCDate(day.getUTCDate() - (6 - i));
        return { label: day.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" }), count: drafts.filter((d) => estDay(d.saved) === day.toISOString().slice(0, 10)).length };
      })
    : [];
  const filtered = useMemo(() => drafts.filter((d) => `${d.recipient} ${d.kind} ${d.detail}`.toLowerCase().includes(search.toLowerCase())), [drafts, search]);
  // the service's list plus payments this browser just created and confirmed (until the index has them)
  const mine = useMemo(() => withOverlay(mineRows, account), [mineRows, account, overlayTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const sentCount = mine && account ? mine.filter((r) => same(r.sender, account)).length : undefined;
  const receivedCount = mine && account ? mine.filter((r) => same(r.recipient, account)).length : undefined;
  const live = ["Sent", "Received", "Approvals", "Refunds", "Activity"] as const;

  return (
    <div className="workspace">
      <aside className="ws-side">
        <Link className="ws-brand" href="/">
          <Image src="/ifso-seal-transparent.png" alt="" width={42} height={42} />
          <span>
            IFSO<small>IF THIS, THEN SO</small>
          </span>
        </Link>
        <p className="ws-caption">YOUR SPACE</p>
        <nav aria-label="Dashboard">
          {nav.map((n) => (
            <button key={n} className={view === n ? "active" : ""} onClick={() => (n === "Create" ? openComposer() : openView(n))}>
              <span>
                <NavIcon name={n} />
              </span>
              {n}
              {n === "Drafts" && <small>{drafts.length}</small>}
            </button>
          ))}
        </nav>
        <div className="ws-side-bottom">
          <div className="ws-seal">
            IF
            <br />
            SO
          </div>
          <p>
            Money that moves
            <br />
            when something happens.
          </p>
          <Link href="/">← Back to website</Link>
        </div>
      </aside>
      <div className="ws-main">
        <header className="ws-top">
          <div>
            <span className="ws-mobile-logo">IFSO / </span>YOUR PAYMENT SPACE <b>✳</b>
          </div>
          <div>
            <label className="ws-top-search">
              <span>⌕</span>
              <input
                placeholder="Search drafts"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  openView("Drafts");
                }}
                aria-label="Search drafts"
              />
            </label>
            <button className="ws-top-icon" aria-label="Settings" onClick={() => openView("Settings")}>
              <NavIcon name="Settings" />
            </button>
            <button className="ws-connect" onClick={account ? () => void wallet.disconnect() : wallet.openPicker} disabled={wallet.busy} title={account ? "Disconnect" : "Connect a wallet"}>
              {account ? shortAddress(account) : "Connect wallet"} ↗
            </button>
            <button className="ws-new" onClick={() => openComposer()}>
              + Create payment
            </button>
          </div>
        </header>
        <div className="ws-body">
          <p className="ws-status" role="status">
            {wallet.status}
          </p>
          {view === "Create" ? (
            <PaymentComposer
              key={editing || "new"}
              draft={drafts.find((d) => d.id === editing)}
              onSave={saveDraft}
              onCancel={() => openView("Overview")}
              onCreated={() => setRefreshKey((k) => k + 1)}
            />
          ) : view === "Overview" ? (
            <>
              <div className="ws-intro">
                <div>
                  <p className="ws-label">YOUR IFSO / OVERVIEW</p>
                  <h1>
                    Everything in <i>motion.</i>
                  </h1>
                  <p>Keep your promises, conditions, and next steps in one place.</p>
                </div>
                <span className="ws-vertical">IF THIS / THEN SO</span>
              </div>
              <div className="ws-grid">
                <article className="ws-card ws-hero-card">
                  <p className="ws-label">WELCOME TO YOUR SPACE</p>
                  <h2>
                    Make room
                    <br />
                    for <i>the moment.</i>
                  </h2>
                  <p>Conditional payments begin with an amount and a clear condition. Explore your drafts or start a new one.</p>
                  <div className="ws-hero-art" aria-hidden="true">
                    <span>IF</span>
                    <b>↗</b>
                    <span>SO</span>
                  </div>
                  <button onClick={() => openComposer()} className="ws-button">
                    START A PAYMENT ↗
                  </button>
                </article>
                <article className="ws-card ws-ring-card">
                  <div className="ws-card-head">
                    <h3>Your activity</h3>
                    <span>{account ? "ON THE CHAIN" : "ON THIS DEVICE"}</span>
                  </div>
                  <div className="ws-ring" data-empty={drafts.length === 0 && !sentCount && !receivedCount}>
                    <span className="ws-ring-mid" />
                    <span className="ws-ring-inner" />
                    <div>
                      <strong>{account && mine ? mine.length : drafts.length}</strong>
                      <span>{account && mine ? "PAYMENTS" : "LOCAL DRAFTS"}</span>
                    </div>
                  </div>
                  <div className="ws-inline">
                    <span>
                      <b>{drafts.length.toString().padStart(2, "0")}</b> Drafts
                    </span>
                    <span>
                      <b>{sentCount ?? "—"}</b> Sent
                    </span>
                    <span>
                      <b>{receivedCount ?? "—"}</b> Received
                    </span>
                  </div>
                </article>
                <article className="ws-card ws-network-card">
                  <div className="ws-card-head">
                    <h3>Condition mix</h3>
                    <span>LOCAL DRAFTS</span>
                  </div>
                  <div
                    className="ws-donut"
                    style={{
                      background: drafts.length
                        ? `conic-gradient(var(--ws-chart-a) 0 ${(100 * (distribution[0] + distribution[1])) / drafts.length}%,var(--ws-chart-b) ${(100 * (distribution[0] + distribution[1])) / drafts.length}% ${(100 * (distribution[0] + distribution[1] + distribution[2] + distribution[3])) / drafts.length}%,var(--ws-chart-c) 0 100%)`
                        : "var(--ws-chart-empty)",
                    }}
                  >
                    <div>
                      <strong>{drafts.length}</strong>
                      <span>DRAFTS</span>
                    </div>
                  </div>
                  <div className="ws-mix-legend">
                    <span>
                      ● Time & price <b>{distribution[0] + distribution[1]}</b>
                    </span>
                    <span>
                      ● Approval <b>{distribution[2] + distribution[3]}</b>
                    </span>
                    <span>
                      ● Results <b>{distribution[4] + distribution[5]}</b>
                    </span>
                  </div>
                </article>
                <article className="ws-card ws-activity-card">
                  <div className="ws-card-head">
                    <h3>{account && mine?.length ? "Recent payments" : "Recent drafts"}</h3>
                    <button onClick={() => openView(account && mine?.length ? "Activity" : "Drafts")}>View all ↗</button>
                  </div>
                  {account && mine?.length ? (
                    mine.slice(0, 3).map((r) => (
                      <div className="ws-entry" key={r.id}>
                        <span className="ws-dot" />
                        <div>
                          <b>{same(r.sender, account) ? `To ${r.recipient ? shortAddress(r.recipient) : "claim link"}` : `From ${shortAddress(r.sender)}`}</b>
                          <small>{when(Date.parse(r.expiry) || 0)}</small>
                        </div>
                        <strong>{(Number(r.amount) / 1e6).toFixed(2)} USDG</strong>
                      </div>
                    ))
                  ) : drafts.length ? (
                    drafts.slice(0, 3).map((d) => (
                      <div className="ws-entry" key={d.id}>
                        <span className="ws-dot" />
                        <div>
                          <b>{d.recipient || "Claim link"}</b>
                          <small>{d.detail}</small>
                        </div>
                        <strong>{Number(d.amount).toFixed(2)} USDG</strong>
                      </div>
                    ))
                  ) : (
                    <div className="ws-empty-small">
                      <span>✳</span>
                      <p>
                        No drafts yet.
                        <br />
                        <button onClick={() => openComposer()}>Start with an intention ↗</button>
                      </p>
                    </div>
                  )}
                </article>
                <article className="ws-card ws-path-card">
                  <div className="ws-card-head">
                    <h3>Draft activity</h3>
                    <span>LAST 7 DAYS</span>
                  </div>
                  <div className="ws-bars">
                    {draftDays.map((day, i) => (
                      <div key={i}>
                        <span className="ws-bar-track">
                          <i style={{ height: `${day.count ? Math.max(15, Math.min(100, day.count * 25)) : 3}%` }} />
                        </span>
                        <small>{day.label}</small>
                      </div>
                    ))}
                  </div>
                  <p>Saved drafts on this device. Your payments are listed under Sent and Received once a wallet is connected.</p>
                </article>
                <article className="ws-card ws-fee-card">
                  <div className="ws-card-head">
                    <h3>Fees at a glance</h3>
                    <Link href="/pricing">Details ↗</Link>
                  </div>
                  <div>
                    <b>0.25</b>
                    <span>
                      USDG
                      <br />
                      CREATION
                    </span>
                  </div>
                  <p>+0.50 USDG for match and market conditions. Confirm the fee before signing.</p>
                </article>
              </div>
              <div className="ws-footnote">Payment history is read from the chain through the IFSO service. Drafts are stored on this browser only.</div>
            </>
          ) : (
            <>
              <div className="ws-section-title">
                <p className="ws-label">YOUR IFSO / {view.toUpperCase()}</p>
                <h1>
                  {view === "Drafts" ? (
                    <>
                      Your <i>drafts.</i>
                    </>
                  ) : view === "Sent" ? (
                    <>
                      Payments you <i>sent.</i>
                    </>
                  ) : view === "Received" ? (
                    <>
                      Payments for <i>you.</i>
                    </>
                  ) : view === "Conditions" ? (
                    <>
                      Choose your <i>moment.</i>
                    </>
                  ) : view === "Guide" ? (
                    <>
                      The IFSO <i>guide.</i>
                    </>
                  ) : (
                    <>
                      {view} <i>at a glance.</i>
                    </>
                  )}
                </h1>
                <p>
                  {view === "Drafts"
                    ? "Saved locally on this browser. Drafts do not move money."
                    : (live as readonly string[]).includes(view)
                      ? "Read from the chain through the IFSO service for the wallet you connected."
                      : view === "Conditions"
                        ? "Each kind of condition has its own path to an answer."
                        : "A few things to know before you make a promise."}
                </p>
              </div>
              {view === "Drafts" ? (
                <section className="ws-ledger ws-card">
                  <div className="ws-card-head">
                    <h3>
                      Drafts <small>({drafts.length})</small>
                    </h3>
                    <input placeholder="Search drafts" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search drafts" />
                  </div>
                  {filtered.length ? (
                    filtered.map((d) => (
                      <div className="ws-entry" key={d.id}>
                        <span className="ws-dot" />
                        <div>
                          <b>{d.recipient || "Claim link"}</b>
                          <small>
                            {d.detail} · {d.kind}
                            {d.expiry ? ` · expires ${when(d.expiry)}` : ""}
                          </small>
                        </div>
                        <strong>{Number(d.amount).toFixed(2)} USDG</strong>
                        <button onClick={() => openComposer(d.id)}>Open ↗</button>
                        <button onClick={() => remove(d.id)}>Delete ×</button>
                      </div>
                    ))
                  ) : (
                    <div className="ws-empty">
                      <span>✳</span>
                      <h2>{search ? "No matching drafts." : "The first page is yours."}</h2>
                      <p>Save a payment draft and it will appear here.</p>
                      <button onClick={() => openComposer()} className="ws-button">
                        CREATE A DRAFT ↗
                      </button>
                    </div>
                  )}
                </section>
              ) : (live as readonly string[]).includes(view) ? (
                <PaymentsView mode={view as (typeof live)[number]} refreshKey={refreshKey} />
              ) : view === "Conditions" ? (
                <section className="ws-condition-list">
                  {offered(
                    [
                      ["date", "Date", "A moment on the calendar."],
                      ["price", "Price", "A feed crosses a level or is read at a deadline."],
                      ["approval", "Both approve", "The sender and recipient agree."],
                      ["referee", "Referee", "Someone you name decides."],
                      ["match", "Match", "A supported fixture reaches a result."],
                      ["market", "Market question", "A supported question reaches its final answer."],
                    ],
                    ([id]) => id,
                  ).map(([id, t, d], i) => [id, String(i + 1).padStart(2, "0"), t, d]).map(([id, n, t, d]) => (
                    <Link href={`/conditions#${id}`} key={n}>
                      <span>{n}</span>
                      <b>{t}</b>
                      <p>{d}</p>
                      <strong>↗</strong>
                    </Link>
                  ))}
                </section>
              ) : view === "Settings" ? (
                <section className="ws-guide ws-card">
                  <h2>
                    Your <i>settings.</i>
                  </h2>
                  <p>Wallet: {account || "Not connected"}. Wallet access is requested only when you choose to connect.</p>
                  {account && (
                    <p>
                      <button className="ws-button" onClick={() => void wallet.disconnect()}>
                        DISCONNECT
                      </button>
                    </p>
                  )}
                  {account && perksError && <p className="wp-error">{perksError}</p>}
                  {perks && (
                    <div className="wp-perks">
                      <h3>Premium features</h3>
                      <p>{perks.wording || (perks.locked.length ? "Premium features unlock when you hold $IFSO." : "")}</p>
                      <ul>
                        {perks.locked.map((p) => (
                          <li key={p.id}>
                            {p.text} <small>{p.unlockText}</small>
                          </li>
                        ))}
                      </ul>
                      <p className="ws-compose-note">{perks.note}</p>
                    </div>
                  )}
                  <p>Drafts are stored on this browser. Remove individual drafts from the Drafts view or clear browser storage.</p>
                  <p>To get notifications in Telegram, send /link to the IFSO bot and follow the button it sends you.</p>
                  <Link href="/privacy-policy" className="ws-button">
                    PRIVACY ↗
                  </Link>
                </section>
              ) : (
                <section className="ws-guide ws-card">
                  <h2>
                    Know your <i>if.</i>
                  </h2>
                  <p>Review the amount, recipient, condition, expiry and cancellation setting before signing.</p>
                  <p>Claim links are private. Anyone who obtains one before the recipient may be able to claim it.</p>
                  <p>Every payment has an expiry. Anyone can initiate a refund after expiry when the payment remains unresolved.</p>
                  <Link href="/risks" className="ws-button">
                    READ THE RISKS ↗
                  </Link>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
