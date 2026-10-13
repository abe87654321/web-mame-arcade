import { describe, expect, it } from "vitest";
import type { PgPool, QueryResult } from "./pg";
import { applyMigrations, loadMigrations, migrationsDir } from "./migrate";

/** A fake pool whose `schema_migrations` table is an in-memory set. */
function fakePool(applied: string[] = []): {
  pool: PgPool;
  calls: string[];
  applied: Set<string>;
} {
  const calls: string[] = [];
  const set = new Set(applied);
  const pool: PgPool = {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      calls.push(sql.trim().split("\n")[0]!);
      if (sql.startsWith("SELECT id FROM schema_migrations")) {
        return { rows: [...set].map((id) => ({ id })) };
      }
      if (sql.startsWith("INSERT INTO schema_migrations")) {
        set.add(params![0] as string);
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {},
  };
  return { pool, calls, applied: set };
}

const m = (id: string): { id: string; sql: string } => ({ id, sql: `-- ${id}` });

describe("migrate", () => {
  it("loads the initial migration from the package", async () => {
    const migrations = await loadMigrations(migrationsDir());
    expect(migrations.map((x) => x.id)).toContain("0001_init.sql");
  });

  it("applies pending migrations in order and records them", async () => {
    const { pool, applied } = fakePool();
    const ran = await applyMigrations(pool, [m("0001_a.sql"), m("0002_b.sql")]);
    expect(ran).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect([...applied]).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("is a no-op when everything is already applied", async () => {
    const { pool, calls } = fakePool(["0001_a.sql"]);
    const ran = await applyMigrations(pool, [m("0001_a.sql")]);
    expect(ran).toEqual([]);
    expect(calls.some((c) => c.startsWith("BEGIN"))).toBe(false);
  });

  it("rolls back a failing migration and rethrows", async () => {
    const { pool, calls, applied } = fakePool();
    const failing: PgPool = {
      query: async (sql, params) => {
        if (sql.startsWith("-- boom")) throw new Error("bad sql");
        return pool.query(sql, params);
      },
      end: async () => {},
    };
    await expect(applyMigrations(failing, [m("boom")])).rejects.toThrow("bad sql");
    expect(calls).toContain("ROLLBACK");
    expect(applied.has("boom")).toBe(false);
  });
});
