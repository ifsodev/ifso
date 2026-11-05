// Live testnet bug (2026-11-05): the bot's usage/help/wrongBot examples and FRONTEND.md used Polymarket slugs that are
// not markets (Gamma /markets/slug answers 404), so a user who copied the example got a preview and was then refused at
// build/sign. Any real slug also goes stale. Every Polymarket slug shown to users must be the placeholder.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { copy } from "../src/core/copy";

const PLACEHOLDER = "the-market-slug";
// "polymarket <slug> resolves|is|settles yes|no" and polymarket.com market links
const SLUG_IN_COMMAND = /\b(?:polymarket|poly|pm)\s+(?:question\s+)?([^\s"'`<>]+)\s+(?:resolves\s+|is\s+|settles\s+)?(?:yes|no)\b/gi;
const SLUG_IN_LINK = /polymarket\.com\/(?:event|market)\/([^\s"'`<>)]+)/gi;

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (typeof v === "function") {
    // call copy builders with recognisable dummies so templates are scanned too
    const r = (v as (...a: string[]) => unknown)("X", "GTE", "1", "AT_DEADLINE", "Y");
    if (typeof r === "string") out.push(r);
  } else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

function slugsIn(text: string): string[] {
  return [...text.matchAll(SLUG_IN_COMMAND), ...text.matchAll(SLUG_IN_LINK)].map((m) => m[1]!);
}

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else if (/\.(ts|tsx|md|mdx|json)$/.test(name)) out.push(p);
  }
  return out;
}

const root = join(import.meta.dir, "..", "..");

describe("Polymarket examples are the placeholder, never a real-looking slug", () => {
  test("bot and API copy", () => {
    const all = strings(copy);
    const found = all.flatMap(slugsIn);
    expect(found.length).toBeGreaterThan(0); // usage and wrongBot do show one
    expect(found.filter((s) => s.toLowerCase() !== PLACEHOLDER)).toEqual([]);
  });

  test("the help says where the market name comes from", () => {
    expect(copy.bot.help).toContain("polymarket.com link");
  });

  test("FRONTEND.md and web/src", () => {
    const files = [join(root, "FRONTEND.md"), ...filesUnder(join(root, "web", "src"))];
    const bad: string[] = [];
    for (const f of files) for (const s of slugsIn(readFileSync(f, "utf8"))) if (s.toLowerCase() !== PLACEHOLDER) bad.push(`${f.slice(root.length + 1)}: ${s}`);
    expect(bad).toEqual([]);
  });

  test("the scanner catches the slugs that shipped", () => {
    expect(slugsIn("/ifso @jake 20 if polymarket fed-decision-in-december resolves yes")).toEqual(["fed-decision-in-december"]);
    expect(slugsIn('"the Polymarket question will-eth-reach-5000-in-2026 resolves YES"')).toEqual(["will-eth-reach-5000-in-2026"]);
    expect(slugsIn("see https://polymarket.com/event/fed-cut-december")).toEqual(["fed-cut-december"]);
  });
});
