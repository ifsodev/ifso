// Planning for premium runs: bulk / CSV createBatch and scheduled payroll. Pure validation + totals; nothing is sent.
// The caller's tier decides the limits (read on the server, see api/perks.ts).
import { getAddress, isAddress } from "viem";
import { formatUsdg, parseUsdg } from "../core/money";

export interface PlanRow {
  line: number;
  recipient: string;
  amountUsdg: string;
}
export interface PlanProblem {
  line: number;
  problem: string;
}

const MIN = 1_000_000n; // 1 USDG, the smallest if-so payment

/** "address,amount" per line; one header line (no address in the first cell) is skipped. Blank lines ignored. */
export function parseCsv(csv: string): { rows: PlanRow[]; problems: PlanProblem[] } {
  const rows: PlanRow[] = [];
  const problems: PlanProblem[] = [];
  const lines = csv.split(/\r?\n/);
  let headerSkipped = false;
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    const [a = "", b = ""] = raw.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    if (!headerSkipped && !isAddress(a)) {
      headerSkipped = true;
      if (i === 0 || rows.length === 0) return;
    }
    rows.push({ line, recipient: a, amountUsdg: b });
  });
  return { rows, problems };
}

export function validateRows(rows: PlanRow[]): { valid: { recipient: string; amount: bigint }[]; problems: PlanProblem[] } {
  const valid: { recipient: string; amount: bigint }[] = [];
  const problems: PlanProblem[] = [];
  for (const r of rows) {
    if (!isAddress(r.recipient)) {
      problems.push({ line: r.line, problem: "not a wallet address" });
      continue;
    }
    let amount: bigint;
    try {
      amount = parseUsdg(r.amountUsdg);
    } catch {
      problems.push({ line: r.line, problem: "not an amount in USDG (up to 6 decimals)" });
      continue;
    }
    if (amount < MIN) {
      problems.push({ line: r.line, problem: "the smallest if-so payment is 1 USDG" });
      continue;
    }
    valid.push({ recipient: getAddress(r.recipient), amount });
  }
  return { valid, problems };
}

export const totals = (valid: { amount: bigint }[], fee: bigint) => {
  const amount = valid.reduce((s, r) => s + r.amount, 0n);
  const fees = fee * BigInt(valid.length);
  return { count: valid.length, amount: amount.toString(), amountText: formatUsdg(amount), fees: fees.toString(), feesText: formatUsdg(fees), total: (amount + fees).toString(), totalText: formatUsdg(amount + fees) };
};
