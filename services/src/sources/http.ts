import { keccak256, toHex, type Hex } from "viem";

export interface Fetched<T> {
  body: T;
  digest: Hex; // keccak256 of the raw body: committed in the on-chain sourcesHash, body stays off-chain
  fetchedAt: number;
}

export async function getJson<T>(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<Fetched<T>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return { body: JSON.parse(text) as T, digest: keccak256(toHex(text)), fetchedAt: Math.floor(Date.now() / 1000) };
  } finally {
    clearTimeout(t);
  }
}
