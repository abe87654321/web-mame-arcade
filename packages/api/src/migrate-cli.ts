/**
 * Migration entry point (T34):
 *   WMA_PG_URL=postgres://... pnpm --filter @wma/api migrate
 */
import { createPool } from "./pg.ts";
import { migrate } from "./migrate.ts";

const url = process.env.WMA_PG_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("WMA_PG_URL (or DATABASE_URL) is required");
  process.exit(1);
}

const pool = createPool({ url });
try {
  const applied = await migrate(pool);
  console.log(
    applied.length > 0
      ? `applied ${applied.length} migration(s): ${applied.join(", ")}`
      : "no pending migrations",
  );
} catch (error) {
  console.error("migration failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
