/**
 * API entry point (T34):
 *   WMA_API_SECRET=... WMA_PG_URL=postgres://... pnpm --filter @wma/api start
 */
import { createPool } from "./pg.ts";
import { buildApp } from "./app.ts";

const secret = process.env.WMA_API_SECRET ?? process.env.WMA_RELAY_SECRET;
if (!secret) {
  console.error("WMA_API_SECRET (or WMA_RELAY_SECRET) is required");
  process.exit(1);
}

const url = process.env.WMA_PG_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("WMA_PG_URL (or DATABASE_URL) is required");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

const pool = createPool({ url });
const app = buildApp({
  pool,
  secret,
  ...(process.env.WMA_TOKEN_TTL_SEC
    ? { tokenTtlSec: Number(process.env.WMA_TOKEN_TTL_SEC) }
    : {}),
  ...(process.env.WMA_LOG_BASE_URL ? { replayBaseUrl: process.env.WMA_LOG_BASE_URL } : {}),
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
