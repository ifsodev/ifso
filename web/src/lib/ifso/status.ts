export const STATUS_TEXT: Record<number, string> = {
  1: "Waiting for its condition",
  2: "Condition met, waiting to be claimed",
  3: "Paid to the recipient",
  4: "Came back to the sender",
  5: "Voided: each side gets its own amount back",
  6: "Cancelled",
};
export const KIND_TEXT: Record<number, string> = { 1: "A date", 2: "A price", 3: "An approval", 4: "A result" };

export const FLAG = { twoSided: 1, accepted: 2, cancellable: 4, senderOk: 8, recipientOk: 16, senderOwed: 32, counterOwed: 64 } as const;
export const has = (flags: number | string, f: number) => (Number(flags) & f) !== 0;
export const isOpen = (status: number) => status === 1 || status === 2;

export const usdgText = (raw: string | bigint) => {
  const v = BigInt(raw);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole.toLocaleString("en-US")}.${frac} USDG`;
};

export const when = (iso: string | number | Date) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
};

export const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Which on-chain voided sides are still owed to `me` (the keeper pays them too; this is the manual way). */
export function owedVoidSide(row: { status: number; voidOwed?: number; sender: string; flags?: number | string }, me: string, acceptor?: string): "sender" | "counter" | undefined {
  if (row.status !== 5) return undefined;
  const owed = Number(row.voidOwed ?? 0);
  if ((owed === 1 || has(row.flags ?? 0, FLAG.senderOwed)) && same(row.sender, me)) return "sender";
  if ((owed === 2 || has(row.flags ?? 0, FLAG.counterOwed)) && same(acceptor, me)) return "counter";
  return undefined;
}
