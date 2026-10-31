import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findBannedWords } from "@/vendor/ifso/client";

// Same endorsement rule as the backend's app/test/bannedWords.test.ts
const ENDORSEMENT = /\b(official|endorsed|approved|sponsored|certified)\s+(by|partner)\b|\bpowered by\b|\bin association with\b/i;

const SRC = join(__dirname, "../src");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "vendor") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|json)$/.test(n) ? [p] : [];
  });
}

/** String literals and JSX text of a source file, with comments removed. */
export function visibleStrings(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const out: string[] = [];
  for (const m of noComments.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of noComments.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) out.push(m[1]!);
  return out.map((s) => s.trim()).filter(Boolean);
}

describe("copy rules", () => {
  const files = walk(SRC).filter((f) => /\.tsx?$/.test(f));
  test("there is something to scan", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.endsWith("composer.tsx"))).toBe(true);
  });
  test("no banned word in any string or JSX text under web/src", () => {
    const hits: string[] = [];
    for (const f of files) for (const s of visibleStrings(readFileSync(f, "utf8"))) for (const w of findBannedWords(s)) hits.push(`${f.replace(SRC, "src")}: ${w} in "${s.slice(0, 80)}"`);
    expect(hits).toEqual([]);
  });
  test("no endorsement wording", () => {
    const hits: string[] = [];
    for (const f of files) for (const s of visibleStrings(readFileSync(f, "utf8"))) if (ENDORSEMENT.test(s)) hits.push(`${f.replace(SRC, "src")}: ${s.slice(0, 80)}`);
    expect(hits).toEqual([]);
  });
  test("the scanner itself catches violations", () => {
    expect(visibleStrings('const a = "Place your bet"; <p>Guaranteed returns</p>').flatMap(findBannedWords).length).toBe(2);
    expect(findBannedWords("better between alphabet")).toEqual([]);
  });
});
