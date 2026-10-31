import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const app = join(__dirname, "../../app/src");
const vendor = join(__dirname, "../src/vendor/ifso");

describe("shared client package", () => {
  test.skipIf(!existsSync(app))("web/src/vendor/ifso is the current copy of app/src (run `bun run sync:client`)", () => {
    for (const f of ["condition", "geo", "link", "linkWallet", "paramsJson", "types", "typedData"]) {
      expect(readFileSync(join(vendor, "core", `${f}.ts`), "utf8"), `core/${f}.ts is stale`).toBe(readFileSync(join(app, "core", `${f}.ts`), "utf8"));
    }
    for (const f of ["claimPage", "copyRules", "verifyBuild"]) {
      expect(readFileSync(join(vendor, "client", `${f}.ts`), "utf8"), `client/${f}.ts is stale`).toBe(readFileSync(join(app, "client", `${f}.ts`), "utf8"));
    }
    const index = readFileSync(join(app, "client/index.ts"), "utf8").replace('"../api/router"', '"../../../lib/ifso/api"');
    expect(readFileSync(join(vendor, "client/index.ts"), "utf8")).toBe(index);
  });
  test("the vendored core imports nothing outside itself or viem", () => {
    for (const f of ["condition", "geo", "link", "linkWallet", "paramsJson", "types", "typedData"]) {
      const imports = [...readFileSync(join(vendor, "core", `${f}.ts`), "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
      for (const i of imports) expect(i === "viem" || i.startsWith("viem/") || i.startsWith("./")).toBe(true);
    }
  });
});
