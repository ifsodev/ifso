import type { Hex } from "viem";

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * The API sends 256-bit numbers as decimal strings. Wallets and viem hash typed data from BigInt, so every field whose
 * declared type is an integer is turned back into a BigInt. Nothing else about the payload changes.
 */
export function reviveTypedData(t: TypedData): TypedData {
  const fields = (t.types as Record<string, { name: string; type: string }[]>)[t.primaryType] ?? [];
  const message: Record<string, unknown> = { ...t.message };
  for (const f of fields) {
    if (/^u?int\d*$/.test(f.type) && typeof message[f.name] === "string") message[f.name] = BigInt(message[f.name] as string);
  }
  const domain: Record<string, unknown> = { ...t.domain };
  if (typeof domain.chainId === "string") domain.chainId = BigInt(domain.chainId);
  return { ...t, domain, message };
}

export type Signer = (typed: TypedData) => Promise<Hex>;
