/**
 * Seed the `games` table from the static catalogue (T34):
 *   WMA_PG_URL=postgres://... pnpm --filter @wma/api seed
 */
import { createPool } from "./pg.ts";
import { loadCatalogue, seedGames } from "./seed.ts";

const url = process.env.WMA_PG_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("WMA_PG_URL (or DATABASE_URL) is required");
  process.exit(1);
}

const pool = createPool({ url });
try {
  const count = await seedGames(pool, await loadCatalogue());
  console.log(`seeded ${count} game(s)`);
} catch (error) {
  console.error("seed failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
