import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { KeyError, decryptKeystore, encryptKeystore, loadHotKey } from "../src/chain/keys";

const pk = generatePrivateKey();
const ks = encryptKeystore(pk, "correct horse", { n: 4096 });
const files: Record<string, string> = { "/k/relayer.json": ks, "/k/pw": "correct horse\n" };
const read = (p: string) => files[p] ?? (() => { throw new Error("no file"); })();

describe("hot keys (R4)", () => {
  test("keystore loads with the right password", () => {
    expect(decryptKeystore(ks, "correct horse")).toBe(pk);
    const acct = loadHotKey("RELAYER", { NODE_ENV: "production", CHAIN_ID: 4663, RELAYER_KEYSTORE: "/k/relayer.json", RELAYER_PASSWORD_FILE: "/k/pw" }, read);
    expect(acct?.address).toBe(privateKeyToAddress(pk));
  });
  test("wrong password fails", () => {
    expect(() => decryptKeystore(ks, "wrong")).toThrow(KeyError);
    files["/k/bad"] = "nope";
    expect(() => loadHotKey("RELAYER", { NODE_ENV: "production", CHAIN_ID: 4663, RELAYER_KEYSTORE: "/k/relayer.json", RELAYER_PASSWORD_FILE: "/k/bad" }, read)).toThrow("wrong keystore password");
  });
  test("production refuses a raw key", () => {
    expect(() => loadHotKey("KEEPER", { NODE_ENV: "production", CHAIN_ID: 31337, KEEPER_PK: pk })).toThrow(KeyError);
  });
  test("raw key refused on a real chain even outside production", () => {
    expect(() => loadHotKey("KEEPER", { NODE_ENV: "development", CHAIN_ID: 4663, KEEPER_PK: pk })).toThrow(KeyError);
  });
  test("raw key accepted on local chain 31337 in development", () => {
    expect(loadHotKey("KEEPER", { NODE_ENV: "development", CHAIN_ID: 31337, KEEPER_PK: pk })?.address).toBe(privateKeyToAddress(pk));
  });
  test("nothing configured gives no key; half configured is an error", () => {
    expect(loadHotKey("RESOLVER", { NODE_ENV: "production", CHAIN_ID: 4663 })).toBeUndefined();
    expect(() => loadHotKey("RESOLVER", { NODE_ENV: "production", CHAIN_ID: 4663, RESOLVER_KEYSTORE: "/k/relayer.json" }, read)).toThrow(KeyError);
  });
  test("errors never contain the key or password", () => {
    try { decryptKeystore(ks, "hunter22"); } catch (e) { expect(String(e)).not.toContain(pk.slice(2)); expect(String(e)).not.toContain("hunter22"); }
  });
});
