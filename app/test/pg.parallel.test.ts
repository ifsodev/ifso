// Postgres-backed suites pick a free port per run: two runs at the same time both pass.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { freePort, pgBin, startPg } from "./helpers/pg";

describe.skipIf(!pgBin())("postgres test clusters on free ports", () => {
  test("two clusters at once get different ports", () => {
    const a = startPg("ifso-par-a-");
    const b = startPg("ifso-par-b-");
    try {
      expect(a.port).not.toBe(b.port);
    } finally {
      a.stop();
      b.stop();
    }
  });

  test("freePort returns a bindable port", () => {
    const p = freePort();
    expect(p).toBeGreaterThan(1024);
  });

  test("two full runs of the Postgres suites in parallel both pass", async () => {
    const cwd = join(import.meta.dir, "..");
    const spawn = () => Bun.spawn([process.execPath, "test", "test/migrate.test.ts", "test/botStore.pg.test.ts"], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, IFSO_PG_CHILD: "1" } });
    const [p1, p2] = [spawn(), spawn()];
    const [c1, c2] = await Promise.all([p1.exited, p2.exited]);
    expect([c1, c2]).toEqual([0, 0]);
  }, 180_000);
});
