// R5: a fresh plain Postgres 16 cluster on a free port migrates from zero, twice. Skips when pg_ctl is missing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { runMigrations } from "../src/db/migrate";
import { pgBin, startPg, type PgCluster } from "./helpers/pg";

const bin = pgBin();

describe.skipIf(!bin)("migrations on a fresh cluster (R5)", () => {
  let pg: PgCluster;
  let url = "";

  beforeAll(() => {
    pg = startPg("ifso-pg-");
    url = pg.url;
  });

  afterAll(() => pg?.stop());

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
