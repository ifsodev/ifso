import { describe, expect, test } from "bun:test";
import { EnvError, loadEnv, missingFor } from "../src/config/env";

const ESCROW = "0x00000000000000000000000000000000000e5c20";

describe("env per role (R1)", () => {
  test("api with nothing set lists names, never values", () => {
    try {
      loadEnv({ SECRET_THING: "hunter2" }, "api");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const m = (e as EnvError).message;
      for (const n of ["DATABASE_URL", "ESCROW_ADDRESS", "REDIS_URL", "RELAYER_KEYSTORE", "RELAYER_PASSWORD_FILE"]) expect(m).toContain(n);
      expect(m).not.toContain("hunter2");
    }
  });
  test("a role does not require another role's variables", () => {
    const base = { DATABASE_URL: "postgres://x", ESCROW_ADDRESS: ESCROW, REDIS_URL: "redis://x" };
    expect(missingFor("api", { ...base, RELAYER_KEYSTORE: "k", RELAYER_PASSWORD_FILE: "p" })).toEqual([]);
    expect(missingFor("bot", { DATABASE_URL: "x", ESCROW_ADDRESS: ESCROW, TELEGRAM_BOT_TOKEN: "t" })).toEqual([]);
    expect(missingFor("bot", { DATABASE_URL: "x", ESCROW_ADDRESS: ESCROW })).toEqual(["TELEGRAM_BOT_TOKEN"]);
    const w = missingFor("worker", base);
    expect(w).toContain("KEEPER_KEYSTORE");
    expect(w).toContain("RESOLVER_ADDRESS");
    expect(w).not.toContain("RELAYER_KEYSTORE");
    expect(w).not.toContain("TELEGRAM_BOT_TOKEN");
  });
  test("production api also needs the IP hash salt", () => {
    expect(missingFor("api", { NODE_ENV: "production" })).toContain("IP_HASH_SALT");
    expect(missingFor("api", {})).not.toContain("IP_HASH_SALT");
  });
  test("a raw dev key counts as a hot key for the check", () => {
    expect(missingFor("api", { DATABASE_URL: "x", ESCROW_ADDRESS: ESCROW, REDIS_URL: "x", RELAYER_PK: "0x01" })).toEqual([]);
  });
  test("main exits non-zero and prints the names", async () => {
    const p = Bun.spawn(["bun", "run", "src/main.ts", "api"], { cwd: `${import.meta.dir}/..`, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(code).not.toBe(0);
    expect(err).toContain("DATABASE_URL");
    expect(err).toContain("ESCROW_ADDRESS");
  });
  test("defaults: two RPC urls in order, plain Postgres on 5442", () => {
    const e = loadEnv({});
    expect(e.RHC_RPC_URLS.split(",")).toEqual(["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.daybreak-rpc.network"]);
    expect(e.DATABASE_URL).toContain(":5442");
  });
});
