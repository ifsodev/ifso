// One payment-id parser for the bot, the API and the site. Real escrow ids are uint256 keccak hashes (76 to 78 digits):
// the old copies capped them at 40 (bot) and 20 (web deep link), so a real id read as "not a number".
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { encodeAbiParameters, keccak256 } from "viem";
import { MAX_PAYMENT_ID, PAYMENT_ID_MAX_DIGITS, PAYMENT_ID_RE, PAYMENT_ID_SOURCE, isPaymentId, parsePaymentId, paymentIdString } from "../src/core/paymentId";
import { paymentIdInput } from "../src/api/router";

/** type(uint256).max: the largest id IfsoEscrow.idFor can return (78 digits). */
const ID_78 = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
/** Real ids from the testnet run (chain 46630, .testnet-people/state.json): 78 and 77 digits. */
const TESTNET_ID_78 = "100445847310731864578693424659970785724122250073438508132425330087614763585464";
const TESTNET_ID_77 = "51376264011080535736083553933417392956537887801181481883072869833438858223172";

describe("parsePaymentId", () => {
  test("the max matches the escrow's uint256 range", () => {
    expect(MAX_PAYMENT_ID.toString()).toBe(ID_78);
    expect(ID_78).toHaveLength(PAYMENT_ID_MAX_DIGITS);
    expect(PAYMENT_ID_RE.source).toBe(`^${PAYMENT_ID_SOURCE}$`);
    expect(PAYMENT_ID_SOURCE).toBe(String.raw`\d{1,${PAYMENT_ID_MAX_DIGITS}}`);
    // an id made the way IfsoEscrow.idFor makes it is always in range
    const made = BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], ["0x00000000000000000000000000000000000000aa", `0x${"ab".repeat(32)}`])));
    expect(parsePaymentId(made.toString())).toBe(made);
  });

  test("accepts real 78- and 77-digit ids, with spaces or a leading #", () => {
    for (const id of [ID_78, TESTNET_ID_78, TESTNET_ID_77, "1", "42"]) {
      expect(parsePaymentId(id)).toBe(BigInt(id));
      expect(parsePaymentId(`  #${id} `)).toBe(BigInt(id));
      expect(PAYMENT_ID_RE.test(id)).toBe(true);
      expect(isPaymentId(id)).toBe(true);
    }
  });

  test("refuses 0, anything above 2^256 - 1, 79 digits, signs, decimals and words", () => {
    for (const bad of ["", " ", "0", "000", (MAX_PAYMENT_ID + 1n).toString(), "1".repeat(79), "-5", "+5", "1.5", "1e9", "0x10", "abc", "12 34", "##12"]) {
      expect(parsePaymentId(bad)).toBeUndefined();
    }
    expect(parsePaymentId(undefined)).toBeUndefined();
    expect(parsePaymentId(null)).toBeUndefined();
  });

  test("the canonical string drops leading zeros (the database key form)", () => {
    expect(paymentIdString("0042")).toBe("42");
    expect(paymentIdString(TESTNET_ID_78)).toBe(TESTNET_ID_78);
    expect(paymentIdString("0")).toBeUndefined();
  });
});

describe("API id input uses the shared parser", () => {
  test("a real 78-digit id passes, an out-of-range one is refused instead of reaching the chain", () => {
    expect(paymentIdInput.parse(ID_78)).toBe(MAX_PAYMENT_ID);
    expect(paymentIdInput.parse(TESTNET_ID_78)).toBe(BigInt(TESTNET_ID_78));
    expect(paymentIdInput.safeParse((MAX_PAYMENT_ID + 1n).toString()).success).toBe(false);
    expect(paymentIdInput.safeParse("0").success).toBe(false);
    expect(paymentIdInput.safeParse("12a").success).toBe(false);
  });
});

describe("no other copy of a payment-id digit limit", () => {
  // A digit limit of 20 or more is an id-sized number: it must come from core/paymentId.ts. A line that limits something
  // else (a block number, say) says so with the words "not a payment id".
  const root = join(import.meta.dir, "../..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      if (n === "node_modules" || n === "vendor" || n.startsWith(".")) return [];
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  test("app/src and web/src read ids through the shared parser", () => {
    const hits: string[] = [];
    for (const dir of ["app/src", "web/src"]) {
      for (const f of files(join(root, dir))) {
        if (f.endsWith(join("core", "paymentId.ts"))) continue;
        readFileSync(f, "utf8").split("\n").forEach((line, i) => {
          const m = /\\d\{1,(\d+)\}/.exec(line);
          if (m && Number(m[1]) >= 20 && !line.includes("not a payment id")) hits.push(`${relative(root, f)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
