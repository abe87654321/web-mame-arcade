#!/usr/bin/env node
/**
 * Game-intake helper (T51). Run this whenever a new `roms/<driver>.zip` appears:
 * it reports which zips are not yet in the catalogue, their sha256 (the
 * `romHash` the catalogue needs), and — when a native build exists — whether the
 * set actually matches the pinned MAME commit, so a bad set is caught before it
 * ships a black-screen core (T49).
 *
 * It does not build or publish anything; it is the read-only version check in
 * front of the steps documented in docs/tasks (T51). The full per-game flow is:
 *   1. node core/onboard-game.mjs --list
 *   2. add the driver's SOURCES to core/drivers.sh, then core/build-native.sh <driver>
 *   3. node core/onboard-game.mjs --check <driver>     (expects "romset is good")
 *   4. add a packages/web/public/games.json entry (romHash from step 1/3)
 *   5. core/build-wasm.sh <driver> && core/publish-web.sh <driver>
 *   6. (optional) discover core/scoremap/<driver>.json   (T47 workflow)
 *   7. node --test core/test/rom-audit.test.mjs && pnpm --filter @wma/e2e test:e2e -g boot
 *
 * Usage: node core/onboard-game.mjs [--list | --check <driver> | --help]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const romsDir = join(repo, "roms");
const gamesFile = join(repo, "packages", "web", "public", "games.json");
const driversFile = join(repo, "core", "drivers.sh");

/** Driver names already published in the catalogue. */
export function catalogueDrivers(games) {
  return games.map((game) => game.driver);
}

/** Zip base names (drivers) not yet present in the catalogue, sorted. */
export function pendingDrivers(zipNames, catalogue) {
  const known = new Set(catalogue);
  return zipNames.filter((name) => !known.has(name)).sort();
}

/** lowercase sha256 hex of a file (the catalogue's romHash / contracts/core-version.md). */
export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Does core/drivers.sh declare a SOURCES entry for this driver? */
export function driversShIncludes(text, driver) {
  return new RegExp(`\\[${driver}\\]=`).test(text);
}

/** Interpret `mame <driver> -verifyroms` output (it exits 0 even when bad). */
export function parseVerifyroms(stdout) {
  return { ok: /1 were OK\./.test(stdout), bad: /is bad/.test(stdout) };
}

function loadGames() {
  return JSON.parse(readFileSync(gamesFile, "utf8"));
}

function zipNames() {
  return readdirSync(romsDir)
    .filter((file) => file.endsWith(".zip"))
    .map((file) => basename(file, ".zip"));
}

function nativeBinary(driver) {
  for (const name of [driver, `${driver}.exe`, `mame${driver}`]) {
    const candidate = join(repo, "mame", name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function cmdList() {
  const games = loadGames();
  const driversText = readFileSync(driversFile, "utf8");
  const pending = pendingDrivers(zipNames(), catalogueDrivers(games));

  if (pending.length === 0) {
    console.log("no pending ROMs: every roms/*.zip has a catalogue entry");
    return;
  }
  console.log(`${pending.length} pending ROM(s) (present in roms/, not in games.json):\n`);
  for (const driver of pending) {
    const zip = join(romsDir, `${driver}.zip`);
    const inDrivers = driversShIncludes(driversText, driver) ? "yes" : "no";
    console.log(
      `  ${driver.padEnd(12)} ${humanSize(statSync(zip).size).padEnd(10)} ` +
        `sha256=${sha256File(zip)}  drivers.sh=${inDrivers}`,
    );
  }
  console.log(
    "\nNext: add each to core/drivers.sh, core/build-native.sh <driver>, then --check <driver>.",
  );
}

function cmdCheck(driver) {
  const games = loadGames();
  const zip = join(romsDir, `${driver}.zip`);
  if (!existsSync(zip)) {
    console.error(`error: no ${zip}`);
    process.exit(2);
  }
  const driversText = readFileSync(driversFile, "utf8");

  console.log(`driver:      ${driver}`);
  console.log(`rom zip:     ${zip} (${humanSize(statSync(zip).size)})`);
  console.log(`romHash:     ${sha256File(zip)}`);
  console.log(`catalogue:   ${catalogueDrivers(games).includes(driver) ? "present" : "MISSING"}`);
  console.log(`drivers.sh:  ${driversShIncludes(driversText, driver) ? "present" : "MISSING (add SOURCES, then core/build-native.sh)"}`);

  const bin = nativeBinary(driver);
  if (bin === null) {
    console.log("native:      not built — run core/build-native.sh " + driver);
  } else {
    const result = spawnSync(bin, [driver, "-rompath", romsDir, "-verifyroms"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    const { ok, bad } = parseVerifyroms(result.stdout ?? "");
    console.log(`native:      ${bin}`);
    console.log(`rom check:   ${ok && !bad ? "OK (set matches the pinned commit)" : "BAD — re-fetch a set matching core/versions.json"}`);
    if (!ok || bad) process.exitCode = 1;
  }
}

function usage() {
  console.log(
    "Usage: node core/onboard-game.mjs [--list | --check <driver> | --help]\n\n" +
      "  --list            zips in roms/ without a catalogue entry, with sha256\n" +
      "  --check <driver>  romHash, catalogue/drivers.sh status, and ROM audit\n" +
      "  --help            this message\n\n" +
      "See docs/tasks/README.md (T51) for the full intake flow.",
  );
}

function main(argv) {
  const [command, arg] = argv;
  switch (command) {
    case "--list":
      cmdList();
      break;
    case "--check":
      if (!arg) {
        console.error("error: --check needs a driver name");
        process.exit(2);
      }
      cmdCheck(arg);
      break;
    case "--help":
    case "-h":
    case undefined:
      usage();
      break;
    default:
      console.error(`error: unknown argument ${command}`);
      usage();
      process.exit(2);
  }
}

// Only run the CLI when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
