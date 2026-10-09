/**
 * Static game catalogue (T13). One entry per driver the arcade exposes; the
 * frontend reads this before the API/DB exist (T34). Field names mirror the
 * `games` table in docs/contracts/db-schema.sql; coreVersion is the core_hash
 * (docs/contracts/core-version.md) and mameCommit is the 40-hex build commit.
 */

export type NetplayMode = "none" | "lockstep" | "rollback";

export interface GameEntry {
  /** MAME driver name, e.g. "gridlee". Unique across the catalogue. */
  driver: string;
  title: string;
  /** core_hash: sha256 of the served WASM core. */
  coreVersion: string;
  /** mame/ commit the core was built from (40-hex). */
  mameCommit: string;
  supportsSave: boolean;
  netplayMode: NetplayMode;
  maxPlayers: number;
  romLicensed: boolean;
  /** Directory URL holding manifest.json and mame<driver>.{js,wasm}. */
  coreBaseUrl: string;
  /** URL of the ROM zip mounted into the core. */
  romZipUrl: string;
}
