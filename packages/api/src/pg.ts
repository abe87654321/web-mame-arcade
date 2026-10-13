/**
 * PostgreSQL connection for the API (T34). The `PgPool` interface keeps routes
 * and tests free of a live database; `createPool` is the only place that loads
 * the `pg` driver.
 */

export interface QueryResult {
  rows: unknown[];
  rowCount?: number | null;
}

export interface PgPool {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
}

export interface DbConfig {
  url: string;
}

export function createPool(config: DbConfig): PgPool {
  let poolPromise: Promise<import("pg").Pool> | null = null;
  const pool = () => {
    poolPromise ??= import("pg").then(
      (m) => new m.Pool({ connectionString: config.url }),
    );
    return poolPromise;
  };
  return {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      const p = await pool();
      const result = await p.query(sql, params as never);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    async end(): Promise<void> {
      if (poolPromise) await (await poolPromise).end();
    },
  };
}
