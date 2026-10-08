import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const repo = join(testDir, "..", "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const pins = JSON.parse(read("core/versions.json"));
const shortCommit = pins.mameCommit.slice(0, 7);
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DESIGN_DOC =
  "docs/Web MAME Arcade — Netplay, Live Streaming & Shared Leaderboard Design.md";

test("versions.json pins are well-formed", () => {
  assert.match(pins.node, /^\d+$/);
  assert.match(pins.emsdk, /^\d+\.\d+\.\d+$/);
  assert.match(pins.mameCommit, /^[0-9a-f]{40}$/);
});

test(".nvmrc and package.json engines match the pinned Node", () => {
  assert.equal(read(".nvmrc").trim(), pins.node);
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.engines.node, new RegExp(`>=${pins.node}\\b`));
});

test("CI pins Node via .nvmrc", () => {
  assert.match(read(".github/workflows/ci.yml"), /node-version-file:\s*\.nvmrc/);
});

test("core/build-native.sh reads the MAME commit from versions.json", () => {
  const script = read("core/build-native.sh");
  assert.match(script, /core\/versions\.json|versions\.json/);
  assert.ok(
    !/PINNED_MAME_COMMIT="[0-9a-f]{7,40}"/.test(script),
    "the MAME commit must not be hardcoded",
  );
  const r = spawnSync("bash", [join(repo, "core", "build-native.sh"), "--dry-run", "gridlee"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`NEW_GIT_VERSION=${shortCommit}`));
});

test("docs/02 pin table mirrors versions.json", () => {
  const d = read("docs/02-emulation-core.md");
  assert.match(d, new RegExp(`\\|\\s*emsdk / Emscripten\\s*\\|\\s*\`${re(pins.emsdk)}\``));
  assert.match(d, new RegExp(`\\|\\s*Node\\.js\\s*\\|\\s*\`${re(pins.node)}\``));
  assert.match(d, new RegExp(`\\|\\s*MAME commit\\s*\\|\\s*\`${re(shortCommit)}\``));
  assert.match(d, /core\/versions\.json/);
  assert.ok(
    !/\|\s*emsdk[^|]*\|\s*`latest`/.test(d),
    "docs/02 still pins emsdk to `latest`",
  );
});

test("design doc references the pinned emsdk and MAME commit", () => {
  const d = read(DESIGN_DOC);
  assert.match(d, new RegExp(`emsdk install ${pins.emsdk.replace(/\./g, "\\.")}`));
  assert.match(d, new RegExp(`\`${shortCommit}\``));
});

test("no emsdk 'latest' pin remains", () => {
  const files = [
    "core/build-native.sh",
    "docs/02-emulation-core.md",
    DESIGN_DOC,
    ".github/workflows/ci.yml",
  ];
  for (const f of files) {
    assert.ok(!/emsdk\s+(install|activate)\s+latest/.test(read(f)), `emsdk latest in ${f}`);
  }
});

test("mame submodule gitlink is the pinned commit", () => {
  const r = spawnSync("git", ["-C", repo, "ls-tree", "HEAD", "--", "mame"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const gitlink = r.stdout.trim().split(/\s+/)[2];
  assert.equal(gitlink, pins.mameCommit, "mame gitlink in HEAD drifts from core/versions.json");
});

test("mame/ working tree matches the pin (skipped until initialised)", (t) => {
  const mameDir = join(repo, "mame");
  if (!existsSync(join(mameDir, ".git")) && !existsSync(join(mameDir, "makefile"))) {
    t.skip("mame/ submodule not initialised");
    return;
  }
  const r = spawnSync("git", ["-C", mameDir, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (r.status !== 0) {
    t.skip("cannot read mame/ HEAD");
    return;
  }
  assert.equal(r.stdout.trim(), pins.mameCommit);
});
