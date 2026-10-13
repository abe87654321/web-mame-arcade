/**
 * Catalogue seeding (T34). The static `packages/web/public/games.json` (T13)
 * predates the database; this copies it into the `games` table so boards and
 * the verifier can resolve a `driver` to a `games.id`.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PgPool } from "./pg.ts";
import { type NewGame, upsertGame } from "./db.ts";

export interface CatalogueEntry {
  driver: string;
  title: string;
  coreVersion: string;
  supportsSave: boolean;
  netplayMode: string;
  maxPlayers: number;
  romLicensed: boolean;
}

/** Project the catalogue entry onto the `games` table columns. */
export function toNewGame(entry: CatalogueEntry): NewGame {
  return {
    driver: entry.driver,
    title: entry.title,
    coreVersion: entry.coreVersion,
    supportsSave: entry.supportsSave,
    netplayMode: entry.netplayMode,
    maxPlayers: entry.maxPlayers,
    romLicensed: entry.romLicensed,
  };
}

/** Upsert every catalogue entry; returns how many were written. */
export async function seedGames(
  pool: PgPool,
  entries: CatalogueEntry[],
): Promise<number> {
  for (const entry of entries) {
    await upsertGame(pool, toNewGame(entry));
  }
  return entries.length;
}

/** Load the static catalogue JSON. */
export async function loadCatalogue(path?: string): Promise<CatalogueEntry[]> {
  const target =
    path ?? fileURLToPath(new URL("../../web/public/games.json", import.meta.url));
  const raw = await readFile(target, "utf8");
  return JSON.parse(raw) as CatalogueEntry[];
}
