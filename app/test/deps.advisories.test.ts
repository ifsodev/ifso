// G34 (audit 2026-11-04): the two app advisories with a non-major fix stay fixed. bun.lock must resolve
// @trpc/server >= 11.8.0 (GHSA-43p4-m455-4f4j) and drizzle-orm >= 0.45.2 (GHSA-gpj5-g38j-94v9). zod 3 -> 4 is a
// major and stays accepted in SECURITY.md (bounded by the 1 MB body cap and .max(5000) arrays).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const lock = readFileSync(join(import.meta.dir, "../bun.lock"), "utf8");
const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
const resolved = (name: string) => lock.match(new RegExp(`\\n    "${name.replace("/", "\\/")}": \\["${name.replace("/", "\\/")}@([0-9.]+)"`))?.[1];
const atLeast = (v: string, min: string) => {
  const [a, b] = [v, min].map((x) => x.split(".").map(Number)) as [number[], number[]];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

describe("G34: patched app dependencies", () => {
  for (const [name, min] of [["@trpc/server", "11.8.0"], ["drizzle-orm", "0.45.2"]] as const) {
    test(`${name} resolves to >= ${min} and is pinned exactly`, () => {
      const v = resolved(name) ?? "missing";
      expect({ name, v, ok: v !== "missing" && atLeast(v, min) }).toEqual({ name, v, ok: true });
      expect(pkg.dependencies[name]).toBe(v);
    });
  }
});
