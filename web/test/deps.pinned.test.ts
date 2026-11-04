// DEPS-1 (audit 2026-11-04): every direct dependency is an exact version, and it is the version bun.lock resolves.
// A `^` range lets a fresh `bun install` (no lockfile, or a lockfile refresh) pick a newer release nobody reviewed.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
const lock = readFileSync(new URL("../bun.lock", import.meta.url), "utf8");
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

describe("web/package.json pins", () => {
  test("no ranges: every direct dependency is an exact x.y.z version", () => {
    const ranged = Object.entries(deps).filter(([, v]) => !EXACT.test(v)).map(([k, v]) => `${k}@${v}`);
    expect(ranged).toEqual([]);
  });

  test("each pin is the version bun.lock resolves (the pin changed no installed version)", () => {
    const off = Object.entries(deps).filter(([k, v]) => !lock.includes(`\n    "${k}": ["${k}@${v}", `)).map(([k, v]) => `${k}@${v}`);
    expect(off).toEqual([]);
  });
});
