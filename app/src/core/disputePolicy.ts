// Review R3-H1: when the resolver service disputes a proposal made by another address. Pure (no I/O), so the
// resolver worker and the property test run exactly the same rules.
//
//  - confirmed     (two final sources agree with the proposal): never disputed.
//  - contradicted  (two final sources agree on a DIFFERENT outcome, or, audit M-2, at least one source is final and
//                  NO final source reports the proposed outcome): disputed at once. We expect the panel to rule
//                  for us, so this does not put the float at risk; it may use the last bond.
//  - unconfirmed   (pending, unavailable or conflicting sources): NOT disputed yet. Re-checked every tick; disputed
//                  only in the last-call slot (closesAt - lastCall .. closesAt) if still unconfirmed, and only while
//                  (a) fewer than `budgetCap` last-call disputes are open and (b) one bond stays in the float after it
//                  (automatic budget = floor(float / bond) - 1). Largest USDG amount first. Over budget: page a human.
import { latestPerProvider, type Agreement, type SourceReport } from "./outcome";

export type SourceVerdict = "confirmed" | "contradicted" | "unconfirmed";

/**
 * `reports` are the source reads behind `a`. Audit M-2: a proposal that a FINAL source contradicts, with no final
 * source backing it, is "contradicted" even when only one source is final yet (the other pending or unavailable),
 * so it is disputed at once instead of waiting for the last-call slot and its bond budget. A proposal that any final
 * source backs stays "unconfirmed" (sources disagree: the panel decides; we never stake on a split).
 */
export function classifyForeign(a: Pick<Agreement, "decision">, proposed: number, reports: Pick<SourceReport, "provider" | "fetchedAt" | "status" | "outcome">[] = []): SourceVerdict {
  if (a.decision !== null && a.decision !== undefined) return a.decision === proposed ? "confirmed" : "contradicted";
  // audit L-7: a later pending read ("event gone") never downgrades a provider's earlier final read
  const finals = latestPerProvider(reports).filter((r) => r.status === "final" && r.outcome !== undefined && r.outcome !== null);
  if (finals.length > 0 && finals.every((r) => r.outcome !== proposed)) return "contradicted";
  return "unconfirmed";
}

export interface ForeignCandidate {
  id: string;
  verdict: SourceVerdict;
  /** Unix seconds: proposedAt + disputeWindow (the contract refuses a dispute at or after it). */
  closesAt: number;
  /** USDG (6 decimals) in funded escrows that depend on this question. */
  atRisk: bigint;
}

export interface PolicyInput {
  now: number;
  lastCall: number;
  bond: bigint;
  /** USDG the resolver key holds right now (bonds already posted are not in it). */
  balance: bigint;
  /** Explicit cap on open last-call disputes; undefined or 0 = automatic (the one-bond reserve alone). */
  budgetCap?: number;
  /** Last-call disputes of ours still open (state DISPUTED). */
  openLastCall: number;
  candidates: ForeignCandidate[];
}

export type Action =
  | { id: string; do: "dispute"; kind: "contradicted" | "last-call" }
  | { id: string; do: "wait" } // unconfirmed, before the slot: re-check next tick
  | { id: string; do: "leave" } // confirmed
  | { id: string; do: "closed" } // the window is over: nothing left to dispute (never finalized by us unless confirmed)
  | { id: string; do: "short"; kind: "contradicted" } // contradicted but less than one bond left
  | { id: string; do: "page"; reason: "budget" | "reserve" }; // unconfirmed in the slot, over budget: a human disputes

export const inLastCall = (now: number, closesAt: number, lastCall: number) => now >= closesAt - lastCall && now < closesAt;

/** The actions for one tick, in the order they must be sent (contradicted first, then last-call by USDG amount). */
export function planForeignDisputes(p: PolicyInput): Action[] {
  const out: Action[] = [];
  let bal = p.balance;
  let open = p.openLastCall;
  const cap = p.budgetCap && p.budgetCap > 0 ? p.budgetCap : Number.POSITIVE_INFINITY;
  const byAtRisk = (a: ForeignCandidate, b: ForeignCandidate) => (a.atRisk > b.atRisk ? -1 : a.atRisk < b.atRisk ? 1 : a.closesAt - b.closesAt || (a.id < b.id ? -1 : 1));
  const open_ = p.candidates.filter((c) => p.now < c.closesAt);
  for (const c of p.candidates) if (p.now >= c.closesAt) out.push({ id: c.id, do: "closed" });
  for (const c of open_.filter((c) => c.verdict === "confirmed")) out.push({ id: c.id, do: "leave" });
  for (const c of open_.filter((c) => c.verdict === "contradicted").sort(byAtRisk)) {
    if (p.bond > 0n && bal >= p.bond) {
      bal -= p.bond;
      out.push({ id: c.id, do: "dispute", kind: "contradicted" });
    } else out.push({ id: c.id, do: "short", kind: "contradicted" });
  }
  for (const c of open_.filter((c) => c.verdict === "unconfirmed").sort(byAtRisk)) {
    if (!inLastCall(p.now, c.closesAt, p.lastCall)) {
      out.push({ id: c.id, do: "wait" });
      continue;
    }
    if (open >= cap) out.push({ id: c.id, do: "page", reason: "budget" });
    else if (p.bond <= 0n || bal < 2n * p.bond) out.push({ id: c.id, do: "page", reason: "reserve" });
    else {
      bal -= p.bond;
      open += 1;
      out.push({ id: c.id, do: "dispute", kind: "last-call" });
    }
  }
  return out;
}
