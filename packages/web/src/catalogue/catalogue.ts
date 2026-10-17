import type { GameEntry, NetplayMode, RomZipRef } from "./types";

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

function parseExtraRomZips(value: unknown): RomZipRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail("bad extraRomZips");
  return value.map((ref, i) => {
    if (typeof ref !== "object" || ref === null) fail(`bad extraRomZips[${i}]`);
    const r = ref as Record<string, unknown>;
    return {
      url: asNonEmptyString(r.url, `extraRomZips[${i}].url`),
      name: asNonEmptyString(r.name, `extraRomZips[${i}].name`),
    };
  });
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
  const romHash = asNonEmptyString(e.romHash, "romHash");
  if (!HEX64.test(romHash)) fail("bad romHash");
  const supportsSave = asBoolean(e.supportsSave, "supportsSave");
  if (!NETPLAY_MODES.includes(e.netplayMode as NetplayMode)) {
    fail("bad netplayMode");
  }
  const netplayMode = e.netplayMode as NetplayMode;
  let rollbackWindow: number | undefined;
  if (e.rollbackWindow !== undefined) {
    if (
      typeof e.rollbackWindow !== "number" ||
      !Number.isInteger(e.rollbackWindow) ||
      e.rollbackWindow < 2 ||
      e.rollbackWindow > 8
    ) {
      fail("bad rollbackWindow");
    }
    rollbackWindow = e.rollbackWindow;
  }
  if (netplayMode === "rollback" && !supportsSave) {
    fail("rollback requires supportsSave");
  }
  if (typeof e.maxPlayers !== "number" || !Number.isInteger(e.maxPlayers) || e.maxPlayers < 1) {
    fail("bad maxPlayers");
  }
  const maxPlayers = e.maxPlayers;
  const romLicensed = asBoolean(e.romLicensed, "romLicensed");
  const coreBaseUrl = asNonEmptyString(e.coreBaseUrl, "coreBaseUrl");
  const romZipUrl = asNonEmptyString(e.romZipUrl, "romZipUrl");
  const extraRomZips = parseExtraRomZips(e.extraRomZips);

  return {
    driver,
    title,
    coreVersion,
    mameCommit,
    romHash,
    supportsSave,
    netplayMode,
    ...(rollbackWindow !== undefined ? { rollbackWindow } : {}),
    maxPlayers,
    romLicensed,
    coreBaseUrl,
    romZipUrl,
    ...(extraRomZips ? { extraRomZips } : {}),
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
