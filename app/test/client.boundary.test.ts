// R1: the client package imports nothing from server-only modules (db, redis, bullmq, grammy ...). The check walks the RUNTIME
// import graph from the package entry (type-only imports are erased and do not count), then bundles it for a browser.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BANNED_WORDS } from "../src/client/copyRules";
import { BANNED } from "./bannedWords.test";

const ENTRY = resolve(import.meta.dir, "../src/client/index.ts");
const ALLOWED_BARE = new Set(["viem", "viem/accounts"]);

function specifiers(raw: string): string[] {
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(\s)\/\/ .*$/gm, "$1");
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']([^"']+)["']/gm)) if (!m[2]) out.push(m[4]!);
  for (const m of src.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) out.push(m[1]!);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

function walk(file: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(file)) return seen;
  const specs = specifiers(readFileSync(file, "utf8"));
  seen.set(file, specs);
  for (const s of specs) {
    if (!s.startsWith(".")) continue;
    const base = resolve(dirname(file), s);
    const real = [base, `${base}.ts`, join(base, "index.ts")].find((p) => existsSync(p) && p.endsWith(".ts"));
    if (!real) throw new Error(`cannot resolve ${s} from ${file}`);
    walk(real, seen);
  }
  return seen;
}

describe("client package boundary (R1)", () => {
  const graph = walk(ENTRY);
  test("the runtime graph is only the client, the shared core and viem", () => {
    const files = [...graph.keys()].map((f) => f.slice(resolve(import.meta.dir, "../src").length + 1));
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) expect(/^(client|core)\//.test(f)).toBe(true);
    for (const [file, specs] of graph) {
      for (const s of specs) {
        if (s.startsWith(".")) continue;
        expect({ file, s, ok: ALLOWED_BARE.has(s) }).toEqual({ file, s, ok: true });
      }
    }
  });
  test("it bundles for a browser with viem external and no node built-ins", async () => {
    const r = await Bun.build({ entrypoints: [ENTRY], target: "browser", format: "esm", external: ["viem"], minify: false });
    expect(r.success).toBe(true);
    const text = await r.outputs[0]!.text();
    expect(text).not.toMatch(/from\s*["'](node:|bun|ioredis|bullmq|grammy|postgres|drizzle|hono)/);
    expect(text).not.toContain("DATABASE_URL");
  });
  test("the package entry exports what the handoff promises", async () => {
    const m = await import("../src/client/index");
    for (const n of ["randomSecret", "linkKeyAddress", "buildClaimUrl", "parseClaimUrl", "readAndWipeFragment", "signClaim", "runClaim", "createAuthorizationTypedData", "createPermitTypedData", "acceptTypedData", "decisionTypedData", "refundRedirectTypedData", "verifyBuildAnswer"]) expect(typeof (m as Record<string, unknown>)[n]).toBe("function");
  });
  test("the banned-word list the site gets is the one the API copy is tested against", () => {
    expect(BANNED_WORDS.map((r) => r.source + r.flags)).toEqual(BANNED.map((r) => r.source + r.flags));
  });
});
