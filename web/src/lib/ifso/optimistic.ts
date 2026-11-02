/**
 * What this browser already knows from a CONFIRMED transaction, laid over the service's lists until its indexer catches
 * up. A cancel, refund, approval or referee decision shows its new state at once instead of "Waiting for its
 * condition" + CANCEL; each entry is dropped as soon as the service reports the same thing (or after a while).
 */
import { decodeEventLog, parseAbi, type Address, type Hex, type Log } from "viem";
import type { MineRow } from "./api";
import { FLAG, isOpen, same } from "./status";

export const escrowEventsAbi = parseAbi([
  "event Approved(uint256 indexed id, address indexed party)",
  "event Met(uint256 indexed id)",
  "event Released(uint256 indexed id, address indexed to, uint256 amount)",
  "event Returned(uint256 indexed id, address indexed to, uint256 amount, uint8 reason)",
  "event Voided(uint256 indexed id, address senderTo, uint256 senderAmount, address counterTo, uint256 counterAmount)",
  "event Cancelled(uint256 indexed id, address indexed to, uint256 amount)",
  "event VoidClaimed(uint256 indexed id, address indexed to, uint256 amount)",
]);

export interface Patch {
  status?: number;
  /** parties whose OK the transaction recorded */
  approvedBy?: Address[];
  /** a voided side was paid (claimVoid) */
  voidPaid?: boolean;
}

/** The escrow state a confirmed receipt proves, read from the escrow's own events for `id`. */
export function patchFromLogs(logs: readonly Pick<Log, "address" | "data" | "topics">[], escrow: Address, id: string): Patch | undefined {
  const p: Patch = {};
  let seen = false;
  for (const l of logs) {
    if (!same(l.address, escrow)) continue;
    let ev: { eventName: string; args: Record<string, unknown> };
    try {
      ev = decodeEventLog({ abi: escrowEventsAbi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] }) as never;
    } catch {
      continue;
    }
    if (String(ev.args.id) !== id) continue;
    seen = true;
    if (ev.eventName === "Approved") p.approvedBy = [...(p.approvedBy ?? []), ev.args.party as Address];
    else if (ev.eventName === "Met") p.status = p.status ?? 2;
    else if (ev.eventName === "Released") p.status = 3;
    else if (ev.eventName === "Returned") p.status = 4;
    else if (ev.eventName === "Voided") p.status = 5;
    else if (ev.eventName === "Cancelled") p.status = 6;
    else if (ev.eventName === "VoidClaimed") p.voidPaid = true;
  }
  return seen ? p : undefined;
}

/** How long a patch may stand in for the service before the service's answer wins regardless. */
export const OVERLAY_TTL_MS = 10 * 60_000;

type Entry = { patch: Patch; at: number };
const patches = new Map<string, Entry>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

export function subscribe(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function recordPatch(id: string, patch: Patch, now = Date.now()) {
  const old = patches.get(id)?.patch;
  patches.set(id, { patch: { ...old, ...patch, approvedBy: [...(old?.approvedBy ?? []), ...(patch.approvedBy ?? [])] }, at: now });
  changed();
}

export function clearOverlay() {
  patches.clear();
  changed();
}

/** The service already shows what the patch says (or more): the patch is no longer needed. */
function caughtUp(row: Pick<MineRow, "status" | "voidOwed">, p: Patch): boolean {
  if (p.status !== undefined) return row.status === p.status || (!isOpen(row.status) && row.status !== 5);
  if (p.voidPaid) return Number(row.voidOwed ?? 0) === 0;
  return false; // an approval alone is not in the list rows; keep it until the TTL
}

/** One row (list row or chain view) with the confirmed patch applied. */
export function patchRow<T extends { status: number; flags?: unknown; voidOwed?: unknown; sender: string; recipient?: unknown }>(row: T, p: Patch | undefined): T {
  if (!p) return row;
  let flags = Number(row.flags ?? 0);
  for (const who of p.approvedBy ?? []) flags |= same(who, row.sender) ? FLAG.senderOk : same(who, row.recipient as string | null | undefined) ? FLAG.recipientOk : 0;
  if (p.voidPaid) flags &= ~(FLAG.senderOwed | FLAG.counterOwed);
  return {
    ...row,
    ...(p.status !== undefined ? { status: p.status } : {}),
    ...(row.flags !== undefined || flags ? { flags } : {}),
    ...(p.voidPaid ? { voidOwed: 0 } : {}),
  };
}

/** Patch for `id` that still applies, given what the service now reports for it (dropped when it caught up). */
export function patchFor(id: string, serviceRow?: Pick<MineRow, "status" | "voidOwed">, now = Date.now()): Patch | undefined {
  const e = patches.get(id);
  if (!e) return undefined;
  if (now - e.at > OVERLAY_TTL_MS || (serviceRow && caughtUp(serviceRow, e.patch))) {
    patches.delete(id);
    return undefined;
  }
  return e.patch;
}

/** The service's rows with every confirmed-but-not-yet-indexed change applied. */
export function withOverlay(rows: MineRow[] | undefined, now = Date.now()): MineRow[] | undefined {
  if (!rows) return rows;
  return rows.map((r) => patchRow(r, patchFor(r.id, r, now)));
}

/** Which rows a ledger tab lists. Refunds = the sender's own payments still open, and voided sides still owed. */
export function rowsForMode(rows: MineRow[], mode: "Sent" | "Received" | "Approvals" | "Refunds" | "Activity", me: string): MineRow[] {
  return rows.filter((r) => {
    if (mode === "Sent") return same(r.sender, me);
    if (mode === "Received") return same(r.recipient, me);
    if (mode === "Approvals") return isOpen(r.status) && r.kind === 3;
    if (mode === "Refunds") return (same(r.sender, me) && isOpen(r.status)) || (r.status === 5 && Number(r.voidOwed ?? 0) !== 0);
    return true;
  });
}
