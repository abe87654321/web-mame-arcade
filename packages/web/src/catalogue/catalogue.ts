import type { GameEntry, NetplayMode } from "./types";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const NETPLAY_MODES: readonly NetplayMode[] = ["none", "lockstep", "rollback"];

function fail(what: string): never {
  throw new Error(`catalogue: ${what}`);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`bad ${field}`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`bad ${field}`);
  return value;
}

function parseEntry(value: unknown): GameEntry {
  if (typeof value !== "object" || value === null) fail("entry not an object");
  const e = value as Record<string, unknown>;

  const driver = asNonEmptyString(e.driver, "driver");
  const title = asNonEmptyString(e.title, "title");
  const coreVersion = asNonEmptyString(e.coreVersion, "coreVersion");
  if (!HEX64.test(coreVersion)) fail("bad coreVersion");
  const mameCommit = asNonEmptyString(e.mameCommit, "mameCommit");
  if (!HEX40.test(mameCommit)) fail("bad mameCommit");
  const supportsSave = asBoolean(e.supportsSave, "supportsSave");
  if (!NETPLAY_MODES.includes(e.netplayMode as NetplayMode)) {
    fail("bad netplayMode");
  }
  const netplayMode = e.netplayMode as NetplayMode;
  if (typeof e.maxPlayers !== "number" || !Number.isInteger(e.maxPlayers) || e.maxPlayers < 1) {
    fail("bad maxPlayers");
  }
  const maxPlayers = e.maxPlayers;
  const romLicensed = asBoolean(e.romLicensed, "romLicensed");
  const coreBaseUrl = asNonEmptyString(e.coreBaseUrl, "coreBaseUrl");
  const romZipUrl = asNonEmptyString(e.romZipUrl, "romZipUrl");

  return {
    driver,
    title,
    coreVersion,
    mameCommit,
    supportsSave,
    netplayMode,
    maxPlayers,
    romLicensed,
    coreBaseUrl,
    romZipUrl,
  };
}

/** Validate a catalogue document, or throw with the offending field. */
export function parseCatalogue(value: unknown): GameEntry[] {
  if (!Array.isArray(value)) fail("not an array");
  const entries = value.map(parseEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.driver)) fail(`duplicate driver ${entry.driver}`);
    seen.add(entry.driver);
  }
  return entries;
}

/** Look up one driver; undefined when absent. */
export function findGame(
  entries: readonly GameEntry[],
  driver: string,
): GameEntry | undefined {
  return entries.find((entry) => entry.driver === driver);
}
