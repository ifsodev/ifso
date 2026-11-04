// CI gate: user-facing copy must never use gambling, yield or endorsement words.
// Scans every string the bot or web app shows (copy.ts) plus bot code, recursively through the copy object.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { copy } from "../src/core/copy";
import fixture from "./fixtures/bot-commands.json";
import { buttonsOf, makeHarness, textOf } from "./helpers/botHarness";
import { render } from "../src/workers/notifier";

export const BANNED = [/\bapy\b/i, /\byield\w*/i, /\bguarantee\w*/i, /\bpartner\w*/i, /\bbet(s|ting|tor)?\b/i, /\bwager\w*/i, /\bodds\b/i, /\bstake[sd]?\b/i, /\bpayouts?\b/i, /\bsportsbook\b/i, /\bgambl\w*/i, /\bwin money\b/i, /\bsafe\w*/i, /can'?t lose/i, /\binsured?\b/i, /licensed escrow/i];
// no endorsement wording for the names we read data from or run on
export const ENDORSEMENT = /\b(official|endorsed|approved|sponsored|certified)\s+(by|partner)\b|\bpowered by\b|\bin association with\b/i;

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
  test("bot and notifier source send only copy.* text (no inline banned words)", () => {
    const dir = join(import.meta.dir, "../src/bot");
    const files = [...readdirSync(dir).map((f) => join(dir, f)), join(import.meta.dir, "../src/workers/notifier.ts")];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const literals = [...src.matchAll(/"([^"\n]{3,})"|`([^`\n]{3,})`/g)].map((m) => m[1] ?? m[2] ?? "");
      for (const re of BANNED) expect(literals.filter((l) => re.test(l))).toEqual([]);
    }
  });
  // CHANGELOG.md is public release-notes copy: every queued update adds an entry there.
  test("CHANGELOG.md (repo root, public release notes) uses no banned or endorsement words", () => {
    const lines = readFileSync(join(import.meta.dir, "../../CHANGELOG.md"), "utf8").split("\n");
    const hits = lines.flatMap((l, i) => [...BANNED, ENDORSEMENT].filter((re) => re.test(l)).map((re) => `CHANGELOG.md:${i + 1} ${re}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });
  test("no endorsement wording in copy", () => {
    expect(strings.filter(([, s]) => ENDORSEMENT.test(s))).toEqual([]);
  });
  test("the matcher itself catches violations", () => {
    expect(BANNED.some((re) => re.test("Place your bet"))).toBe(true);
    expect(BANNED.some((re) => re.test("better between alphabet"))).toBe(false);
  });
});

// R4: every reply the bot produces for the 100 scripted commands (previews, questions, errors, notes), every
// question button label, and every notifier message.
describe("banned words in generated bot text (R4)", () => {
  test("previews, questions, buttons and errors for all scripted commands", async () => {
    const h = makeHarness();
    const seen: string[] = [];
    for (const c of fixture.cases as { input: string; tz?: string }[]) {
      if (c.tz) await h.say(`/tz ${c.tz}`);
      const out = await h.say(c.input);
      seen.push(textOf(out), ...buttonsOf(out).map((b) => b.text as string));
      for (const b of buttonsOf(out)) if (b.callback_data) seen.push(textOf(await h.press(b.callback_data)));
    }
    expect(seen.filter(Boolean).length).toBeGreaterThan(150);
    for (const re of BANNED) expect(seen.filter((t) => re.test(t))).toEqual([]);
    expect(seen.filter((t) => ENDORSEMENT.test(t))).toEqual([]);
  });

  test("every notifier message", () => {
    const names = ["Created", "Claimed", "Accepted", "Met", "Released", "Returned", "Voided", "Proposed", "Disputed"];
    const args = { amount: "20000000", to: "0x00000000000000000000000000000000000000aa", outcome: 1 };
    const out = names.flatMap((n) => (["sender", "recipient", "referee"] as const).map((role) => render(n, { role, amount: "20000000", questionTitle: "Arsenal v Chelsea" }, args)));
    expect(out.filter(Boolean).length).toBe(names.length * 3);
    for (const re of BANNED) expect(out.filter((t) => t && re.test(t))).toEqual([]);
  });
});
