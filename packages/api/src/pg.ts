/**
 * PostgreSQL connection for the API (T34). The `PgPool`/`PgClient` interfaces
 * keep routes and tests free of a live database; `createPool` is the only place
 * that loads the `pg` driver.
 */

export interface QueryResult {
  rows: unknown[];
  rowCount?: number | null;
}

export interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

/** A single checked-out connection; release it when done. */
export interface PgClient extends PgQueryable {
  release(): void;
}

export interface PgPool extends PgQueryable {
  /**
   * Check out a dedicated connection. Needed for multi-statement transactions
   * (migrations): `pool.query` picks an arbitrary connection per call.
   */
  connect(): Promise<PgClient>;
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
    async connect(): Promise<PgClient> {
      const p = await pool();
      const client = await p.connect();
      return {
        async query(sql: string, params?: unknown[]): Promise<QueryResult> {
          const result = await client.query(sql, params as never);
          return { rows: result.rows, rowCount: result.rowCount };
        },
        release(): void {
          client.release();
        },
      };
    },
    async end(): Promise<void> {
      if (poolPromise) await (await poolPromise).end();
    },
  };
}
