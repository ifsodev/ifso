// CI gate: user-facing copy must never use gambling, yield or endorsement words.
// Scans every string the bot or web app shows (copy.ts) plus bot code, recursively through the copy object.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copy } from "../src/core/copy";

export const BANNED = [/\bapy\b/i, /\byield\w*/i, /\bguarantee\w*/i, /\bpartner\w*/i, /\bbet(s|ting|tor)?\b/i, /\bwager\w*/i, /\bodds\b/i, /\bstake[sd]?\b/i, /\bpayouts?\b/i, /\bsportsbook\b/i, /\bgambl\w*/i, /\bwin money\b/i];

function collect(v: unknown, path = "copy"): [string, string][] {
  if (typeof v === "string") return [[path, v]];
  if (typeof v === "function") {
    // render templates with neutral sample args
    const out = (v as (...a: unknown[]) => unknown)("X", "GTE", "1", "AT_DEADLINE", "Y");
    return collect(out, `${path}()`);
  }
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => collect(x, `${path}.${k}`));
  return [];
}

describe("banned words in user-facing copy", () => {
  const strings = collect(copy);
  test("copy object is non-trivial", () => expect(strings.length).toBeGreaterThan(40));
  for (const re of BANNED) {
    test(`no ${re}`, () => {
      const hits = strings.filter(([, s]) => re.test(s)).map(([p, s]) => `${p}: ${s}`);
      expect(hits).toEqual([]);
    });
  }
  test("bot source sends only copy.* text (no inline banned words)", () => {
    const src = readFileSync(join(import.meta.dir, "../src/bot/bot.ts"), "utf8");
    const literals = [...src.matchAll(/"([^"\n]{3,})"|`([^`\n]{3,})`/g)].map((m) => m[1] ?? m[2] ?? "");
    for (const re of BANNED) expect(literals.filter((l) => re.test(l))).toEqual([]);
  });
  test("the matcher itself catches violations", () => {
    expect(BANNED.some((re) => re.test("Place your bet"))).toBe(true);
    expect(BANNED.some((re) => re.test("better between alphabet"))).toBe(false);
  });
});
