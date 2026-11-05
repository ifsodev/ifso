// Audit I-15: contracts/deployments/<chainId>.json is the one deployment record; the site's copy in
// src/config/deployments must equal it byte for byte (run `bash scripts/sync-deployments.sh`). A chain with no record
// has an empty placeholder. After a redeploy only the record changes, then the sync script and this test.
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/lib/ifso/config";

const records = join(__dirname, "../../contracts/deployments");
const copies = join(__dirname, "../src/config/deployments");

describe("deployment records", () => {
  for (const id of [4663, 46630, 31337]) {
    test.skipIf(!existsSync(records))(`web copy of ${id}.json equals contracts/deployments (or is the empty placeholder)`, () => {
      const copy = readFileSync(join(copies, `${id}.json`), "utf8");
      const record = join(records, `${id}.json`);
      if (existsSync(record)) expect(copy, `${id}.json is stale: run bash scripts/sync-deployments.sh`).toBe(readFileSync(record, "utf8"));
      else expect(JSON.parse(copy)).toEqual({ chainId: id, contracts: {} });
    });
  }
  test("each copy names its own chain, and a deployed chain gives the site its escrow address", () => {
    for (const id of [4663, 46630, 31337] as const) {
      const d = JSON.parse(readFileSync(join(copies, `${id}.json`), "utf8"));
      expect(d.chainId).toBe(id);
      const escrow = d.contracts?.IfsoEscrow?.address;
      if (escrow) expect(loadConfig({ NEXT_PUBLIC_CHAIN_ID: String(id) }).escrow?.toLowerCase()).toBe(escrow.toLowerCase());
    }
  });
});
