// R5: a fresh plain Postgres 16 cluster on port 5442 migrates from zero, twice. Skips when pg_ctl is missing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { runMigrations } from "../src/db/migrate";

const PORT = 5442;
const bin = ["/opt/homebrew/opt/postgresql@16/bin", "/usr/local/opt/postgresql@16/bin", "/usr/lib/postgresql/16/bin"].find((d) => existsSync(join(d, "pg_ctl"))) ?? Bun.which("pg_ctl")?.replace(/\/pg_ctl$/, "");
const run = (cmd: string[]) => Bun.spawnSync(cmd, { env: { ...process.env, LC_ALL: "C", LANG: "C" }, stdout: "pipe", stderr: "pipe" });

describe.skipIf(!bin)("migrations on a fresh cluster (R5)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ifso-pg-"));
  const data = join(dir, "data");
  const url = `postgres://ifso@127.0.0.1:${PORT}/postgres`;
  let started = false;

  beforeAll(() => {
    const init = run([`${bin}/initdb`, "-D", data, "-U", "ifso", "--auth=trust", "-E", "UTF8", "--locale=C"]);
    if (init.exitCode !== 0) throw new Error(init.stderr.toString());
    const start = run([`${bin}/pg_ctl`, "-D", data, "-w", "-l", join(dir, "log"), "-o", `-p ${PORT} -k ${dir} -c listen_addresses=127.0.0.1`, "start"]);
    if (start.exitCode !== 0) throw new Error(start.stderr.toString() + start.stdout.toString());
    started = true;
  });

  afterAll(() => {
    if (started) run([`${bin}/pg_ctl`, "-D", data, "-m", "fast", "-w", "stop"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("migrates from zero twice without error and creates the round cache as a normal table", async () => {
    await runMigrations(url);
    await runMigrations(url);
    const sql = postgres(url, { max: 1 });
    const tables = (await sql`select table_name from information_schema.tables where table_schema='public'`).map((r) => r.table_name as string);
    for (const t of ["escrows", "questions", "price_rounds", "chain_events", "cursors", "relay_txs"]) expect(tables).toContain(t);
    const idx = await sql`select indexdef from pg_indexes where tablename='price_rounds' and indexname='price_rounds_time_idx'`;
    expect(idx[0]?.indexdef).toContain("(feed, updated_at)");
    const ext = await sql`select extname from pg_extension where extname='timescaledb'`;
    expect(ext.length).toBe(0);
    await sql.end();
  }, 60_000);
});
