import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(here, "..", "determinism-spike.sh");
const run = (...args) => spawnSync("bash", [script, ...args], { encoding: "utf8" });

const binary = join(repoRoot, "mame", "gridlee");
const rom = join(repoRoot, "roms", "gridlee.zip");
const haveMame = existsSync(binary) && existsSync(rom);

test("--help exits 0", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test("unknown driver is rejected", () => {
  const r = run("pacman", "--dry-run");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown driver: pacman/);
});

test("--dry-run default prints record and playback commands", () => {
  const r = run("--dry-run");
  assert.equal(r.status, 0);
  for (const flag of [
    "-record",
    "-playback",
    "-autoboot_script",
    "-nothrottle",
    "-video none",
    "-sound none",
    "-skip_gameinfo",
    "-noreadconfig",
  ]) {
    assert.match(r.stdout, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(r.stdout, /run\("record", 36000/);
  assert.match(r.stdout, /--rounds 10/);
  assert.match(r.stdout, /--replays 2/);
});

test("--dry-run honours --frames/--rounds/--replays", () => {
  const r = run("--dry-run", "--frames", "120", "--rounds", "1", "--replays", "2");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /run\("record", 120/);
});

test("integration: strict short spike is deterministic", { skip: haveMame ? false : "mame/gridlee or roms/gridlee.zip missing" }, () => {
  const r = run("--frames", "120", "--rounds", "2", "--replays", "2");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /RESULT: PASS/);
});
