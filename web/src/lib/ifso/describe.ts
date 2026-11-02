import { shortAddress } from "./wallet";
import { when } from "./status";

interface Cond {
  kind?: number | string;
  mode?: number | string;
  op?: number | string;
  target?: string;
  threshold?: string | number;
  deadline?: string | number;
  start?: string | number;
}

const secs = (v: string | number | undefined) => (v === undefined ? 0 : Number(v) * 1000);

/**
 * One plain sentence for the claim page, built only from the condition the CHAIN returned (via the API's `escrow`
 * query), never from the link. Prices are 8-decimal feed units.
 */
export function describeOnChainCondition(c: Cond, ticker?: string): string {
  const kind = Number(c.kind);
  if (kind === 1) return `It unlocks on ${when(secs(c.deadline))}.`;
  if (kind === 2) {
    const price = (Number(BigInt(c.threshold ?? 0)) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 4 });
    const dir = Number(c.op) === 1 ? "at or below" : "at or above";
    const what = ticker ?? `the price on feed ${shortAddress(c.target ?? "0x")}`; // the ticker comes from the service's feed list
    if (Number(c.mode) === 1) return `It unlocks if ${what} reaches ${dir} ${price} between ${when(secs(c.start))} and ${when(secs(c.deadline))}.`;
    return `It unlocks if ${what} is ${dir} ${price} at ${when(secs(c.deadline))}.`;
  }
  if (kind === 3) return Number(c.mode) === 1 ? `It unlocks when the referee ${shortAddress(c.target ?? "0x")} releases it.` : "It unlocks when both people approve.";
  if (kind === 4) return "It unlocks when a match or market question reaches the result it was set up for. The result is posted to the IFSO resolver and can be disputed for 2 hours.";
  return "";
}
