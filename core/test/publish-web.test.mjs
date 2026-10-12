import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const script = join(testDir, "..", "publish-web.sh");

const HASH = "d".repeat(64);
const COMMIT = "b".repeat(40);

/** A fake repo: core/out/gridlee/<build>/ + packages/web/public/games.json. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wma-publish-"));
  const build = join(root, "core", "out", "gridlee", "build-1");
  mkdirSync(build, { recursive: true });
  writeFileSync(
    join(build, "manifest.json"),
    JSON.stringify({
      driver: "gridlee",
      core_hash: HASH,
      mame_commit: COMMIT,
      emsdk: "6.0.2",
      artifacts: { "gridlee.wasm": "a".repeat(64), "gridlee.js": "c".repeat(64) },
    }),
  );
  writeFileSync(join(build, "gridlee.wasm"), "wasm");
  writeFileSync(join(build, "gridlee.js"), "js");
  const publicDir = join(root, "packages", "web", "public");
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(
    join(publicDir, "games.json"),
    JSON.stringify([
      {
        driver: "gridlee",
        title: "Gridlee",
        coreVersion: "old",
        mameCommit: "old",
        coreBaseUrl: "/static/cores/gridlee",
      },
    ]),
  );
  return root;
}

const run = (root, ...args) =>
  spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, WMA_REPO_ROOT: root },
  });

test("no driver prints usage and exits non-zero", () => {
  const r = run(fixture());
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage:/);
});

test("--help exits 0", () => {
  const r = run(fixture(), "--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test("unknown driver is rejected", () => {
  const r = run(fixture(), "pacman");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no build for 'pacman'/);
});

test("--dry-run reports the core hash and writes nothing", () => {
  const root = fixture();
  const r = run(root, "gridlee", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(HASH));
  assert.ok(!existsSync(join(root, "packages", "web", "public", "static")));
});

test("publishes artifacts and points games.json at the new core hash", () => {
  const root = fixture();
  const r = run(root, "gridlee");
  assert.equal(r.status, 0, r.stderr);

  const dest = join(root, "packages", "web", "public", "static", "cores", "gridlee", HASH);
  assert.ok(existsSync(join(dest, "gridlee.wasm")), "wasm copied");
  assert.ok(existsSync(join(dest, "gridlee.js")), "js copied");
  assert.ok(existsSync(join(dest, "manifest.json")), "manifest copied");

  const games = JSON.parse(
    readFileSync(join(root, "packages", "web", "public", "games.json"), "utf8"),
  );
  assert.equal(games[0].coreVersion, HASH);
  assert.equal(games[0].mameCommit, COMMIT);
});

test("copies the scoremap when one exists", () => {
  const root = fixture();
  const scoremapSrc = join(root, "core", "scoremap");
  mkdirSync(scoremapSrc, { recursive: true });
  writeFileSync(join(scoremapSrc, "gridlee.json"), '{"v":1,"players":[]}');

  const r = run(root, "gridlee");
  assert.equal(r.status, 0, r.stderr);
  const dst = join(root, "packages", "web", "public", "static", "scoremap", "gridlee.json");
  assert.ok(existsSync(dst), "scoremap copied");
});
