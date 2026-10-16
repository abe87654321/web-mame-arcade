import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  catalogueDrivers,
  driversShIncludes,
  parseSavestate,
  parseVerifyroms,
  pendingDrivers,
  sha256File,
} from "../onboard-game.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repo = join(testDir, "..", "..");

test("catalogueDrivers lists every games.json driver", () => {
  assert.deepEqual(
    catalogueDrivers([{ driver: "gridlee" }, { driver: "twincobr" }]),
    ["gridlee", "twincobr"],
  );
});

test("pendingDrivers returns roms/ zips with no catalogue entry, sorted", () => {
  assert.deepEqual(
    pendingDrivers(["zebra", "commando", "gwar"], ["commando"]),
    ["gwar", "zebra"],
  );
  assert.deepEqual(pendingDrivers(["a"], ["a"]), []);
});

test("driversShIncludes matches a declare -A entry, not a substring", () => {
  const text = 'declare -A DRIVER_SOURCES=(\n  [gridlee]="a.cpp"\n  [raiden2]="b.cpp"\n)';
  assert.equal(driversShIncludes(text, "gridlee"), true);
  assert.equal(driversShIncludes(text, "raiden"), false);
  assert.equal(driversShIncludes(text, "gwar"), false);
});

test("parseVerifyroms distinguishes a good set from a bad one", () => {
  assert.deepEqual(
    parseVerifyroms("romset raiden2 is good\n1 romsets found, 1 were OK."),
    { ok: true, bad: false },
  );
  assert.deepEqual(
    parseVerifyroms("romset raiden is bad\n1 romsets found, 0 were OK."),
    { ok: false, bad: true },
  );
});

test("parseSavestate reads MAME's netplay capability flag", () => {
  assert.equal(parseSavestate('<machine name="raiden"><driver savestate="supported"/></machine>'), "supported");
  assert.equal(parseSavestate('<driver savestate="unsupported"/>'), "unsupported");
  assert.equal(parseSavestate("<machine/>"), undefined);
  assert.equal(parseSavestate(""), undefined);
});

test("sha256File equals the streaming sha256 of the bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "wma-onboard-"));
  try {
    const file = join(dir, "sample.bin");
    const bytes = Buffer.from("web-mame-arcade\u0000\u0001\u0002", "binary");
    writeFileSync(file, bytes);
    assert.equal(
      sha256File(file),
      createHash("sha256").update(bytes).digest("hex"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI --help exits 0 and documents the commands", () => {
  const result = spawnSync("node", [join(repo, "core", "onboard-game.mjs"), "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--list/);
  assert.match(result.stdout, /--check/);
});
