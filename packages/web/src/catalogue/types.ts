/**
 * Static game catalogue (T13). One entry per driver the arcade exposes; the
 * frontend reads this before the API/DB exist (T34). Field names mirror the
 * `games` table in docs/contracts/db-schema.sql; coreVersion is the core_hash
 * (docs/contracts/core-version.md) and mameCommit is the 40-hex build commit.
 */

export type NetplayMode = "none" | "lockstep" | "rollback";

/**
 * A ROM zip MAME needs in addition to the driver's own zip: the parent set of a
 * clone (e.g. `gemini.zip` for `geminij`) or a required device/bios ROM (e.g.
 * `m68705p5.zip` for `tigerh`). `name` must match the MAME set name because
 * MAME selects sets by the zip's base name under `-rompath`.
 */
export interface RomZipRef {
  url: string;
  name: string;
}

export interface GameEntry {
  /** MAME driver name, e.g. "gridlee". Unique across the catalogue. */
  driver: string;
  title: string;
  /** core_hash: sha256 of the served WASM core. */
  coreVersion: string;
  /** mame/ commit the core was built from (40-hex). */
  mameCommit: string;
  /** rom_hash: sha256 of the served ROM zip (contracts/core-version.md). */
  romHash: string;
  supportsSave: boolean;
  netplayMode: NetplayMode;
  maxPlayers: number;
  romLicensed: boolean;
  /** Directory URL holding manifest.json and mame<driver>.{js,wasm}. */
  coreBaseUrl: string;
  /** URL of the ROM zip mounted into the core. */
  romZipUrl: string;
  /**
   * Extra zips MAME needs (parent set / device ROM); mounted alongside
   * `romZipUrl` under `-rompath`. Omitted when the game is a self-contained set.
   */
  extraRomZips?: readonly RomZipRef[];
}
