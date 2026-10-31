/**
 * A passkey smart account for a visitor with no wallet (ZeroDev Kernel v3.1 + passkey validator 0.0.3, both deployed on
 * Robinhood Chain). The key pair is made by the device (WebAuthn); only the public key is kept, in this browser, so the
 * account can sign later. The account address is counterfactual: USDG can be sent to it before it is deployed, so the
 * claim itself needs no UserOp and no paymaster. No server is involved in creating it (the SDK's hosted passkey server
 * is not used: this page may talk only to the API and the chain RPC).
 */
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants";
import { createKernelAccount } from "@zerodev/sdk";
import { PasskeyValidatorContractVersion, toPasskeyValidator } from "@zerodev/passkey-validator";
import { bytesToHex, keccak256, type Address } from "viem";
import { publicClient } from "@/lib/ifso/chain";

const STORE = "ifso-passkey-v1";
export interface SavedPasskey {
  address: Address;
  pubX: string;
  pubY: string;
  authenticatorId: string;
  authenticatorIdHash: `0x${string}`;
  created: string;
}

export const b64urlToBytes = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
/** keccak256 of the credential id bytes: what the validator stores to find the credential again. */
export const authenticatorIdHash = (credentialId: string) => keccak256(bytesToHex(b64urlToBytes(credentialId)));

/** SPKI DER of a P-256 key -> the two 32-byte coordinates. */
export async function p256Coordinates(spki: ArrayBuffer): Promise<{ x: bigint; y: bigint }> {
  const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key)); // 0x04 || X || Y
  return { x: BigInt(bytesToHex(raw.slice(1, 33))), y: BigInt(bytesToHex(raw.slice(33, 65))) };
}

export function loadSavedPasskey(): SavedPasskey | undefined {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as SavedPasskey) : undefined;
  } catch {
    return undefined;
  }
}

async function addressFor(key: { pubX: bigint; pubY: bigint; authenticatorId: string; authenticatorIdHash: `0x${string}` }): Promise<Address> {
  const client = publicClient();
  const entryPoint = getEntryPoint("0.7");
  const validator = await toPasskeyValidator(client, {
    webAuthnKey: { ...key, rpID: location.hostname },
    entryPoint,
    kernelVersion: KERNEL_V3_1,
    validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
  });
  const account = await createKernelAccount(client, { plugins: { sudo: validator }, entryPoint, kernelVersion: KERNEL_V3_1 });
  return account.address;
}

/** Asks the device for a new passkey and returns the account address it controls. Throws if the device refuses. */
export async function createPasskeyAccount(): Promise<SavedPasskey> {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new Error("This browser cannot make a passkey. Use a wallet instead.");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "IFSO", id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "ifso-claim", displayName: "IFSO claim" },
      challenge,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created.");
  const spki = (cred.response as AuthenticatorAttestationResponse).getPublicKey();
  if (!spki) throw new Error("The device did not return a public key.");
  const { x, y } = await p256Coordinates(spki);
  const key = { pubX: x, pubY: y, authenticatorId: cred.id, authenticatorIdHash: authenticatorIdHash(cred.id) };
  const address = await addressFor(key);
  const saved: SavedPasskey = { address, pubX: x.toString(), pubY: y.toString(), authenticatorId: key.authenticatorId, authenticatorIdHash: key.authenticatorIdHash, created: new Date().toISOString() };
  try {
    localStorage.setItem(STORE, JSON.stringify(saved));
  } catch {
    /* the address is still shown; the page tells the visitor to write it down */
  }
  return saved;
}
