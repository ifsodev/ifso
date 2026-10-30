// Hot keys (relayer, keeper, resolver) come from an encrypted keystore (JSON v3) plus a password file.
// A raw *_PK variable is accepted only on a local chain (31337) outside production. Keys are never logged.
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Env, HotKeyName } from "../config/env";

export class KeyError extends Error {}

interface KeystoreV3 {
  version: 3;
  crypto: {
    cipher: string;
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: "scrypt" | "pbkdf2";
    kdfparams: { dklen: number; salt: string; n?: number; r?: number; p?: number; c?: number; prf?: string };
    mac: string;
  };
}

const bytes = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");

/** Decrypt a keystore JSON v3 (as written by `cast wallet new` / geth). Throws KeyError on a wrong password. */
export function decryptKeystore(json: string, password: string): Hex {
  let ks: KeystoreV3;
  try {
    ks = JSON.parse(json) as KeystoreV3;
  } catch {
    throw new KeyError("keystore is not valid JSON");
  }
  const c = ks.crypto;
  if (ks.version !== 3 || !c) throw new KeyError("unsupported keystore format");
  const kp = c.kdfparams;
  let dk: Buffer;
  if (c.kdf === "scrypt") {
    const n = kp.n!, r = kp.r!, p = kp.p!;
    dk = scryptSync(password, bytes(kp.salt), kp.dklen, { N: n, r, p, maxmem: 256 * n * r + 64 * 1024 * 1024 });
  } else if (c.kdf === "pbkdf2") {
    dk = pbkdf2Sync(password, bytes(kp.salt), kp.c!, kp.dklen, "sha256");
  } else throw new KeyError("unsupported keystore kdf");
  const ct = bytes(c.ciphertext);
  const mac = keccak256(bytesToHex(Buffer.concat([dk.subarray(16, 32), ct])));
  if (mac.toLowerCase() !== `0x${c.mac.replace(/^0x/, "")}`.toLowerCase()) throw new KeyError("wrong keystore password");
  const d = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), bytes(c.cipherparams.iv));
  return bytesToHex(Buffer.concat([d.update(ct), d.final()]));
}

/** Encrypt a private key into keystore JSON v3 (scrypt). Used by tests and local tooling. */
export function encryptKeystore(pk: Hex, password: string, opts: { n?: number } = {}): string {
  const n = opts.n ?? 262144, r = 8, p = 1;
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const dk = scryptSync(password, salt, 32, { N: n, r, p, maxmem: 256 * n * r + 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(hexToBytes(pk))), cipher.final()]);
  const mac = keccak256(bytesToHex(Buffer.concat([dk.subarray(16, 32), ct]))).slice(2);
  const ks: KeystoreV3 = {
    version: 3,
    crypto: {
      cipher: "aes-128-ctr",
      ciphertext: ct.toString("hex"),
      cipherparams: { iv: iv.toString("hex") },
      kdf: "scrypt",
      kdfparams: { dklen: 32, salt: salt.toString("hex"), n, r, p },
      mac,
    },
  };
  return JSON.stringify(ks);
}

type KeyEnv = Pick<Env, "NODE_ENV" | "CHAIN_ID"> & Partial<Record<string, string | number | bigint | undefined>>;

/** Load one hot key. Returns undefined when nothing is configured for it. */
export function loadHotKey(name: HotKeyName, env: KeyEnv, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): PrivateKeyAccount | undefined {
  const ksPath = env[`${name}_KEYSTORE`] as string | undefined;
  const pwPath = env[`${name}_PASSWORD_FILE`] as string | undefined;
  const raw = env[`${name}_PK`] as string | undefined;
  if (raw) {
    if (env.NODE_ENV === "production" || env.CHAIN_ID !== 31337) {
      throw new KeyError(`${name}_PK is only accepted on a local chain (31337) outside production; use ${name}_KEYSTORE`);
    }
    return privateKeyToAccount(raw as Hex);
  }
  if (!ksPath && !pwPath) return undefined;
  if (!ksPath || !pwPath) throw new KeyError(`${name}_KEYSTORE and ${name}_PASSWORD_FILE must both be set`);
  const password = readFile(pwPath).replace(/\r?\n$/, "");
  return privateKeyToAccount(decryptKeystore(readFile(ksPath), password));
}
