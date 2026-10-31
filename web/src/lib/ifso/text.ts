/** Builds the command text the API parses from the composer's fields. */
export interface ComposerFields {
  kind: string;
  amount: string;
  recipient: string;
  detail: string;
  challenge?: boolean;
  counter?: string;
}

export const KINDS: [value: string, label: string, hint: string][] = [
  ["date", "A date arrives", "nov 1, or 9am friday, or in 3 days"],
  ["price", "A price moves", "eth at or above 4000 by friday"],
  ["approval", "Both people approve", "we both approve"],
  ["referee", "A referee decides", "0x… decides (the referee's address)"],
  ["match", "A match ends", "arsenal win"],
  ["market", "A question resolves", "polymarket the-market-slug resolves yes"],
];

const CONNECTIVE = /^(if|when|on|at|in|once)\s+/i;

export function commandText(f: ComposerFields): string {
  const detail = f.detail.trim().replace(/\s+/g, " ");
  const to = f.recipient.trim() || "link";
  const amount = f.amount.trim();
  const head = f.challenge ? "/challenge" : "/ifso";
  const money = f.challenge && f.counter?.trim() ? `${amount} vs ${f.counter.trim()}` : amount;
  const tail = CONNECTIVE.test(detail) ? detail : `${f.kind === "date" ? "on" : "if"} ${detail}`;
  return `${head} ${to} ${money} ${tail}`;
}

export const isAddressLike = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
