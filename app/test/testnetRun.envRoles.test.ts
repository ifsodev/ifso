// Testnet run 2026-11-01: the live API answered every OUTCOME build with "RESOLVER_ADDRESS is not configured" (500) and
// every sports build with "couldn't turn ... into a condition". provision.sh writes the "[section: worker]" block of
// scripts/server/env.example to /etc/ifso/worker.env only, and RESOLVER_ADDRESS and ODDS_API_KEY sat in that block, but
// the API process reads both (router build/submit for OUTCOME, api/fixtures.ts for the sports listing). Every variable the
// API code reads must therefore live in the common or api section of the template.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const template = readFileSync(join(root, "scripts/server/env.example"), "utf8");

function sections(): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  let cur = "";
  for (const line of template.split("\n")) {
    const s = /^# \[section: (\w+)\]/.exec(line);
    if (s) { cur = s[1]!; out[cur] = new Set(); continue; }
    const k = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (k && cur) out[cur]!.add(k[1]!);
  }
  return out;
}

/** env variables read by code the api role runs: src/api/*, the shared chain clients and the resolver planners it calls */
function apiReads(): Set<string> {
  const files = [
    ...readdirSync(join(root, "src/api")).filter((f) => f.endsWith(".ts")).map((f) => join(root, "src/api", f)),
    join(root, "src/chain/index.ts"),
  ];
  const vars = new Set<string>();
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/env\.([A-Z][A-Z0-9_]*)/g)) vars.add(m[1]!);
  return vars;
}

describe("server env template: the api role gets every variable it reads", () => {
  test("RESOLVER_ADDRESS and ODDS_API_KEY reach the api (common or api section)", () => {
    const s = sections();
    const apiSide = new Set([...(s.common ?? []), ...(s.api ?? [])]);
    expect(apiSide.has("RESOLVER_ADDRESS")).toBe(true);
    expect(apiSide.has("ODDS_API_KEY")).toBe(true);
  });

  test("no variable read by api code is only in the worker section", () => {
    const s = sections();
    const apiSide = new Set([...(s.common ?? []), ...(s.api ?? [])]);
    const workerOnly = [...apiReads()].filter((v) => s.worker?.has(v) && !apiSide.has(v));
    expect(workerOnly).toEqual([]);
  });
});
