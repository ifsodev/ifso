import { Kind } from "./types";

export const USDG_DECIMALS = 6;

export function parseUsdg(s: string): bigint {
  const t = s.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) throw new Error(`bad USDG amount: ${s}`);
  const [w, f = ""] = t.split(".");
  return BigInt(w!) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}

export function formatUsdg(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const w = a / 1_000_000n;
  const f = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${w}${f ? "." + f : ""}`;
}

/** Mirrors IfsoEscrow.feeFor: flat creation fee, plus the flat resolver fee for OUTCOME. Never a percentage. */
export function feeFor(kind: Kind, creationFee: bigint, resolverFee: bigint): bigint {
  return kind === Kind.OUTCOME ? creationFee + resolverFee : creationFee;
}
