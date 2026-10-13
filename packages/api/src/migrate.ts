/**
 * Minimal forward-only SQL migration runner (T34). Migrations are
 * `NNNN_name.sql` files applied in lexical order, each recorded in the
 * `schema_migrations` table so a re-run is a no-op. The schema contract is
 * docs/contracts/db-schema.sql; `0001_init.sql` mirrors it.
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgPool } from "./pg.ts";

export interface Migration {
  id: string;
  sql: string;
}

const CREATE_MIGRATIONS =
  "CREATE TABLE IF NOT EXISTS schema_migrations (" +
  "id text PRIMARY KEY, " +
  "applied_at timestamptz NOT NULL DEFAULT now())";

/** Read every `*.sql` file in `dir`, sorted by filename. */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(
    names.map(async (id) => ({ id, sql: await readFile(resolve(dir, id), "utf8") })),
  );
}

/** Apply pending migrations; returns the ids applied this run. */
export async function applyMigrations(
  pool: PgPool,
  migrations: Migration[],
): Promise<string[]> {
  await pool.query(CREATE_MIGRATIONS);
  const { rows } = await pool.query("SELECT id FROM schema_migrations");
  const applied = new Set((rows as { id: string }[]).map((row) => row.id));

  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    await pool.query("BEGIN");
    try {
      await pool.query(migration.sql);
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    ran.push(migration.id);
  }
  return ran;
}

/** Directory holding the API's migration files. */
export function migrationsDir(): string {
  return fileURLToPath(new URL("./migrations", import.meta.url));
}

/** Load and apply all pending migrations against `pool`. */
export async function migrate(pool: PgPool): Promise<string[]> {
  return applyMigrations(pool, await loadMigrations(migrationsDir()));
}
