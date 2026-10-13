/**
 * Verifier worker entry point (T33).
 *
 * Usage:
 *   node --import tsx packages/verifier/src/main.ts
 *
 * Required env vars:
 *   VERIFY_REDIS_URL      Redis URL (e.g. redis://localhost:6379)
 *   VERIFY_MAME_BIN       Path to native MAME binary
 *   VERIFY_PG_URL         PostgreSQL connection string
 *   VERIFY_LOG_DIR        Where relay stores input logs (default: data/input-logs)
 *   VERIFY_SCOREMAP_DIR   Where scoremap JSONs live (default: core/scoremap)
 *   VERIFY_ROM_DIR        Where ROM zips live (default: roms)
 *
 * Optional:
 *   VERIFY_PINNED_COMMIT  MAME commit that this build must match (default: from core/versions.json)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "./db.js";
import { startWorker } from "./worker.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

function readVersions() {
  const raw = readFileSync(resolve(ROOT, "core/versions.json"), "utf8");
  return JSON.parse(raw) as { mameCommit: string };
}

async function main() {
  const redisUrl = process.env.VERIFY_REDIS_URL;
  if (!redisUrl) {
    console.error("VERIFY_REDIS_URL is required");
    process.exit(1);
  }

  const mameBin = process.env.VERIFY_MAME_BIN;
  if (!mameBin) {
    console.error("VERIFY_MAME_BIN is required");
    process.exit(1);
  }

  const pgUrl = process.env.VERIFY_PG_URL;
  if (!pgUrl) {
    console.error("VERIFY_PG_URL is required");
    process.exit(1);
  }

  const logDir = process.env.VERIFY_LOG_DIR ?? "data/input-logs";
  const scoremapDir = process.env.VERIFY_SCOREMAP_DIR ?? resolve(ROOT, "core/scoremap");
  const romDir = process.env.VERIFY_ROM_DIR ?? resolve(ROOT, "roms");
  const pinnedCommit =
    process.env.VERIFY_PINNED_COMMIT ?? readVersions().mameCommit;

  const pgPool = createPool({ url: pgUrl });

  const logger =
    process.env.VERIFY_LOG_LEVEL === "debug"
      ? (event: string, fields: Record<string, unknown>) =>
          console.log(JSON.stringify({ event, ...fields }))
      : undefined;

  console.log("Verifier worker starting", {
    redisUrl,
    mameBin,
    pgUrl: pgUrl.replace(/:[^:@]+@/, ":****@"),
    logDir,
    scoremapDir,
    romDir,
    pinnedCommit,
  });

  await startWorker({
    redisUrl,
    mameBin,
    romDir,
    scoremapDir,
    logDir,
    pgPool,
    pinnedMameCommit: pinnedCommit,
    log: logger,
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
