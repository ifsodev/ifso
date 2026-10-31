// Claim links (Peanut-style, clean-room). The secret lives ONLY in the URL fragment (#...), which browsers
// never send to servers. The web app derives an ephemeral secp256k1 key from it; the escrow stores that
// key's address (`linkKey`). Claiming = the ephemeral key signs EIP-712 Claim(id, recipient, conditionHash),
// so whoever submits the tx (relayer, recipient, a mempool copier) cannot change where the money goes.
import {
  bytesToHex,
  concat,
  hexToBigInt,
  keccak256,
  numberToHex,
  recoverTypedDataAddress,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { acceptTypes, claimTypes, ifsoDomain } from "./typedData";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // not-a-key
const LINK_DOMAIN_TAG = toBytes("ifso.link.v1");
export const LINK_VERSION = "1";

export function randomSecret(): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Deterministic secret -> private key. Re-hashes in the (astronomically unlikely) out-of-range case. */
export function deriveLinkPrivateKey(secret: Uint8Array): Hex {
  if (secret.length !== 32) throw new Error("link secret must be 32 bytes");
  let k = keccak256(concat([LINK_DOMAIN_TAG, secret]));
  for (let i = 0; i < 8; i++) {
    const n = hexToBigInt(k);
    if (n > 0n && n < SECP256K1_N) return k;
    k = keccak256(concat([toBytes(k), toBytes(numberToHex(i, { size: 1 }))]));
  }
  throw new Error("could not derive link key");
}

export function linkAccount(secret: Uint8Array) {
  return privateKeyToAccount(deriveLinkPrivateKey(secret));
}

export function linkKeyAddress(secret: Uint8Array): Address {
  return linkAccount(secret).address;
}

/** https://ifso.tech/c/<id base64url>#1.<secret base64url> — the id is public (it's on-chain), the secret is not. */
export function buildClaimUrl(baseUrl: string, id: bigint, secret: Uint8Array): string {
  const idBytes = toBytes(numberToHex(id, { size: 32 }));
  return `${baseUrl.replace(/\/$/, "")}/c/${b64urlEncode(idBytes)}#${LINK_VERSION}.${b64urlEncode(secret)}`;
}

export function parseClaimUrl(url: string): { id: bigint; secret: Uint8Array } {
  const u = new URL(url);
  const m = u.pathname.match(/\/c\/([A-Za-z0-9_-]{43})$/);
  if (!m) throw new Error("not an IFSO claim link");
  const frag = u.hash.replace(/^#/, "");
  const [ver, sec] = frag.split(".");
  if (ver !== LINK_VERSION || !sec) throw new Error("unsupported link version");
  const secret = b64urlDecode(sec);
  if (secret.length !== 32) throw new Error("bad link secret");
  return { id: hexToBigInt(bytesToHex(b64urlDecode(m[1]!))), secret };
}

export async function signClaim(args: {
  secret: Uint8Array;
  chainId: number;
  escrow: Address;
  id: bigint;
  recipient: Address;
  conditionHash: Hex;
}): Promise<Hex> {
  return linkAccount(args.secret).signTypedData({
    domain: ifsoDomain(args.chainId, args.escrow),
    types: claimTypes,
    primaryType: "Claim",
    message: { id: args.id, recipient: args.recipient, conditionHash: args.conditionHash },
  });
}

export async function signAccept(args: {
  secret: Uint8Array;
  chainId: number;
  escrow: Address;
  id: bigint;
  acceptor: Address;
  conditionHash: Hex;
}): Promise<Hex> {
  return linkAccount(args.secret).signTypedData({
    domain: ifsoDomain(args.chainId, args.escrow),
    types: acceptTypes,
    primaryType: "Accept",
    message: { id: args.id, acceptor: args.acceptor, conditionHash: args.conditionHash },
  });
}

/** Server-side pre-check before relaying (the contract re-checks; this just avoids wasting gas). */
export async function recoverClaimSigner(args: {
  chainId: number;
  escrow: Address;
  id: bigint;
  recipient: Address;
  conditionHash: Hex;
  signature: Hex;
}): Promise<Address> {
  return recoverTypedDataAddress({
    domain: ifsoDomain(args.chainId, args.escrow),
    types: claimTypes,
    primaryType: "Claim",
    message: { id: args.id, recipient: args.recipient, conditionHash: args.conditionHash },
    signature: args.signature,
  });
}
