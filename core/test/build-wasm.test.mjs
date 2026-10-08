import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const script = join(testDir, "..", "build-wasm.sh");
const pins = JSON.parse(readFileSync(join(testDir, "..", "versions.json"), "utf8"));
const run = (...args) => spawnSync("bash", [script, ...args], { encoding: "utf8" });

test("no driver prints usage and exits non-zero", () => {
  const r = run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage:/);
});

test("unknown driver is rejected", () => {
  const r = run("pacman");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown driver: pacman/);
});

test("--list-drivers includes gridlee", () => {
  const r = run("--list-drivers");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\bgridlee\b/);
});

test("--dry-run gridlee prints a reproducible emmake command", () => {
  const r = run("--dry-run", "gridlee");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SUBTARGET=gridlee/);
  assert.match(r.stdout, /src\/mame\/bally\/gridlee\.cpp/);
  assert.match(r.stdout, /IGNORE_GIT=1/);
  assert.match(r.stdout, /STRIP_SYMBOLS=1/);
  assert.match(r.stdout, new RegExp(`NEW_GIT_VERSION=${pins.mameCommit.slice(0, 7)}`));
  assert.match(r.stdout, /core\/out\/gridlee\//);
  assert.match(r.stdout, new RegExp(`emsdk[^\\n]*${pins.emsdk.replace(/\./g, "\\.")}`));
});

test("--help exits 0", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});
