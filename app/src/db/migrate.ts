// Idempotent migration runner: `bun run db:migrate`. Plain Postgres 16 only (no extensions).
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join } from "node:path";
import { createDb } from "./client";

export const MIGRATIONS = join(import.meta.dir, "../../drizzle");

export async function runMigrations(url: string) {
  const { db, sql } = createDb(url);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL ?? "postgres://ifso:ifso@localhost:5442/ifso";
  await runMigrations(url);
  console.log(JSON.stringify({ t: new Date().toISOString(), scope: "migrate", msg: "migrations applied" }));
}
