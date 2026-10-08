import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "build-native.sh");
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

test("--dry-run gridlee prints the make command", () => {
  const r = run("--dry-run", "gridlee");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SUBTARGET=gridlee/);
  assert.match(r.stdout, /src\/mame\/bally\/gridlee\.cpp/);
});

test("--help exits 0", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});
