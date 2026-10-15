import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// T49 regression guard: a catalogue driver whose locally-supplied ROM zip does
// not satisfy the pinned MAME commit boots to a black screen. MAME refuses to
// start on a bad set and blocks on the "ROMs are incorrect / Press any key"
// modal, so play-controller still reports "running <title>" while nothing draws
// — and the machine's address spaces are never populated, so every
// netplay_read_bytes call returns -1. That is exactly how raiden/raiden2 were
// broken: the zips were raidenj-era (MAME 0.225) sets, missing 4.u023 and the
// two raiden2 PALs that MAME 0.289 requires.
//
// This asserts the opposite of the bug: for every catalogue driver whose native
// build and ROM zip are present here, `mame <driver> -verifyroms` must report
// the set as OK. It uses the driver's own name because the catalogue's `driver`
// is also the MAME system name (see catalogue/types.ts). CI has neither the
// native binaries nor the gitignored roms/, so every case skips there; the
// guard bites on a developer/publish machine, before a black-screen core ships.
//
// Run: node --test core/test/rom-audit.test.mjs

const testDir = dirname(fileURLToPath(import.meta.url));
const repo = join(testDir, "..", "..");
const romsDir = join(repo, "roms");

const games = JSON.parse(
  readFileSync(join(repo, "packages", "web", "public", "games.json"), "utf8"),
);

/** The native build of a driver, if present (build-native.sh output names). */
function nativeBinary(driver) {
  for (const name of [driver, `${driver}.exe`, `mame${driver}`]) {
    const candidate = join(repo, "mame", name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

test("catalogue drivers with local ROMs pass MAME's own ROM audit", () => {
  let audited = 0;
  for (const game of games) {
    const { driver } = game;
    const bin = nativeBinary(driver);
    const zip = join(romsDir, `${driver}.zip`);
    if (bin === null || !existsSync(zip)) {
      // Not built / no ROM here (CI): the set cannot be audited, so skip it.
      continue;
    }
    audited += 1;
    const result = spawnSync(
      bin,
      [driver, "-rompath", romsDir, "-verifyroms"],
      { cwd: repo, encoding: "utf8" },
    );
    assert.equal(
      result.error,
      undefined,
      `${driver}: could not run ${bin}: ${String(result.error)}`,
    );
    // -verifyroms exits 0 even for a bad set, so assert on stdout. A bad set
    // prints "N romsets found, 0 were OK." and "romset <driver> is bad".
    assert.match(
      result.stdout,
      /1 were OK\./,
      `${driver}: local ROM set does not match the pinned MAME commit ` +
        `(would boot to a black screen). Re-fetch a set matching core/versions.json.\n` +
        result.stdout,
    );
    assert.doesNotMatch(
      result.stdout,
      /is bad/,
      `${driver}: MAME reports the romset as bad\n${result.stdout}`,
    );
  }
  // Informational: prints in the TAP output so a green run is still legible.
  console.log(`rom-audit: ${audited} driver(s) audited, ${games.length - audited} skipped`);
});

test("catalogue romHash matches the local ROM zip byte-for-byte", () => {
  // contracts/core-version.md: rom_hash is the sha256 of the served ROM zip.
  // The web app ships games.json's romHash as the closed log's `rom_hash`, so a
  // swapped zip must update the catalogue or replays claim the wrong ROM.
  let checked = 0;
  for (const game of games) {
    const zip = join(romsDir, `${game.driver}.zip`);
    if (!existsSync(zip)) continue; // ROM not present here (CI)
    checked += 1;
    const actual = createHash("sha256").update(readFileSync(zip)).digest("hex");
    assert.equal(
      game.romHash,
      actual,
      `${game.driver}: games.json romHash is stale; set it to ${actual}`,
    );
  }
  console.log(`rom-audit: ${checked} romHash(s) checked`);
});
