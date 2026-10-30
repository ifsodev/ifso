// R4: FRONTEND.md documents every tRPC procedure, every client function it tells the team to use exists, and the doc itself
// follows the copy rules (outside the one line that lists the banned words).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appRouter } from "../src/api/router";
import * as client from "../src/client";
import { BANNED, ENDORSEMENT } from "./bannedWords.test";

const doc = readFileSync(join(import.meta.dir, "../../FRONTEND.md"), "utf8");
const procedures = Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);

describe("FRONTEND.md covers the API (R4)", () => {
  test("the router has the procedures we expect (a rename must update the doc)", () => expect(procedures.length).toBeGreaterThanOrEqual(17));
  for (const name of procedures) test(`procedure ${name} has its own section`, () => expect(doc).toContain(`### \`${name}\``));
  test("no section documents a procedure that does not exist", () => {
    const documented = [...doc.matchAll(/^### `(\w+)`$/gm)].map((m) => m[1]!);
    expect(documented.filter((n) => !procedures.includes(n))).toEqual([]);
  });
  test("every plain endpoint is listed", () => {
    for (const e of ["/healthz", "/readyz", "/geo", "/stats/users", "/q/"]) expect(doc).toContain(e);
  });
  test("the topics the coordinator asked for are present", () => {
    for (const t of ["ambiguities", "questions", "weekend", "perks", "planBatch", "planPayroll", "stats", "prepareQuestion", "hold N $IFSO to unlock", "/link", "linkWalletMessage", "ZeroDev Kernel v3.1", "Content-Security-Policy", "readAndWipeFragment"]) expect(doc).toContain(t);
  });
});

describe("client functions named in the doc exist", () => {
  const named = [...new Set([...doc.matchAll(/\b(randomSecret|linkKeyAddress|buildClaimUrl|parseClaimUrl|readAndWipeFragment|signClaim|signAccept|runClaim|verifyBuildAnswer|createPermitTypedData|acceptTypedData|acceptAuthorizationTypedData|decisionTypedData|refundRedirectTypedData|linkWalletMessage|findBannedWords|DecisionAction)\b/g)].map((m) => m[1]!))];
  test("at least the core set is mentioned", () => expect(named.length).toBeGreaterThan(12));
  for (const n of named) test(`${n}`, () => expect((client as Record<string, unknown>)[n]).toBeDefined());
});

describe("the doc follows the copy rules", () => {
  const body = doc.split("\n").filter((l) => !l.startsWith("- Never use:") && !l.includes("Never use")).join("\n");
  for (const re of BANNED) test(`no ${re}`, () => expect(body.match(re)).toBeNull());
  test("no endorsement wording", () => expect(body.replace(/"powered by", "official", "approved by"/, "").match(ENDORSEMENT)).toBeNull());
});
