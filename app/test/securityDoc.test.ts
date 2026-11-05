// Audit I-20 (rescore of d6b7a57): SECURITY.md's role text must agree with its own signer table. Both mainnet
// multisigs exist, so no line may still call one "not created yet", and the panel multisig's signers are never the
// owner multisig's.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const doc = readFileSync(join(import.meta.dir, "../../SECURITY.md"), "utf8");
const rows = doc.split("\n").filter((l) => l.startsWith("| ") && /multisig/i.test(l));
const addrs = (l: string) => l.match(/0x[0-9a-fA-F]{40}/g) ?? [];

describe("I-20: SECURITY.md multisig text matches the signer table", () => {
  test("the signer table lists the owner and the panel multisig with three signers each", () => {
    const owner = rows.filter((l) => /^\| Owner multisig signer \d/.test(l)).flatMap(addrs);
    const panel = rows.filter((l) => /^\| Panel multisig signers/.test(l)).flatMap(addrs);
    expect(rows.some((l) => /^\| Owner multisig \(/.test(l) && addrs(l).length === 1)).toBe(true);
    expect(rows.some((l) => /^\| Panel multisig \(/.test(l) && addrs(l).length === 1)).toBe(true);
    expect(new Set(owner.map((a) => a.toLowerCase())).size).toBe(3);
    expect(new Set(panel.map((a) => a.toLowerCase())).size).toBe(3);
    expect(owner.filter((a) => panel.some((p) => p.toLowerCase() === a.toLowerCase()))).toEqual([]);
  });

  test("no line says a multisig is not created yet", () => {
    const flat = doc.replace(/\s+/g, " ");
    expect(flat).not.toMatch(/multisig[^.|]*not created yet/i);
    expect(flat).toMatch(/On mainnet both multisigs exist/);
  });
});
