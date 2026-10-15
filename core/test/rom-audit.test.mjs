import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
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
// Two checks per catalogue driver, each skipping when its inputs are absent so
// CI (no native binaries, no gitignored ROMs) stays green while a developer's
// machine is protected before a black-screen core ships:
//   1. `mame <driver> -verifyroms` reports the set as OK (driver name is also
//      the MAME system name — see packages/web/src/catalogue/types.ts);
//   2. games.json's romHash equals the sha256 of roms/<driver>.zip
//      (contracts/core-version.md: rom_hash is the served zip's sha256).
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

for (const game of games) {
  const { driver } = game;
  const bin = nativeBinary(driver);
  const zip = join(romsDir, `${driver}.zip`);

  test(`${driver}: local ROM set satisfies the pinned MAME commit`, (t) => {
    if (bin === null || !existsSync(zip)) {
      t.skip(`no native build / ROM zip for ${driver} here (CI)`);
      return;
    }
    const result = spawnSync(bin, [driver, "-rompath", romsDir, "-verifyroms"], {
      cwd: repo,
      encoding: "utf8",
      // Deterministic MAME output regardless of the caller's locale.
      env: { ...process.env, LC_ALL: "C" },
    });
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
  });

  test(`${driver}: games.json romHash matches roms/${driver}.zip`, (t) => {
    if (!existsSync(zip)) {
      t.skip(`no ROM zip for ${driver} here (CI)`);
      return;
    }
    const actual = createHash("sha256").update(readFileSync(zip)).digest("hex");
    assert.equal(
      game.romHash,
      actual,
      `${driver}: games.json romHash is stale; set it to ${actual}`,
    );
  });
}
