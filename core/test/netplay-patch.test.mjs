import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const core = join(testDir, "..");
const repo = join(core, "..");
const mame = join(repo, "mame");
const apply = join(core, "patches", "apply.sh");

const run = (...args) =>
  spawnSync("bash", [apply, ...args], { encoding: "utf8", cwd: repo });
const git = (...args) =>
  spawnSync("git", ["-C", mame, ...args], { encoding: "utf8" });

const mameReady = () => existsSync(join(mame, "makefile"));

// New files apply.sh copies into the tree, and tracked files it edits.
const NEW_FILES = ["src/emu/netplay.h", "src/emu/netplay.cpp", "scripts/resources/emscripten/netplay_post.js"];
const MODIFIED = [
  "src/emu/machine.cpp",
  "src/emu/ioport.cpp",
  "src/emu/save.h",
  "src/emu/save.cpp",
  "scripts/src/emu.lua",
  "scripts/genie.lua",
];

const porcelain = () => {
  const r = git("status", "--porcelain");
  assert.equal(r.status, 0, r.stderr);
  const tracked = [];
  const untracked = [];
  for (const raw of r.stdout.split("\n")) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    const path = raw.slice(3);
    if (code.includes("?")) untracked.push(path);
    else tracked.push({ code, path });
  }
  return { tracked, untracked };
};

test("apply.sh --help names its subcommands and exits 0", () => {
  const r = run("--help");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /apply/);
  assert.match(r.stdout, /revert/);
  assert.match(r.stdout, /status/);
  assert.match(r.stdout, /hash/);
});

test("unknown subcommand is rejected", () => {
  const r = run("frobnicate");
  assert.notEqual(r.status, 0);
});

test("hash prints one stable lowercase 64-hex line", () => {
  const a = run("hash");
  const b = run("hash");
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout.trim(), /^[0-9a-f]{64}$/);
  assert.equal(a.stdout.trim(), b.stdout.trim());
});

test("apply -> status -> revert keeps the mame tree pristine", (t) => {
  if (!mameReady()) {
    t.skip("mame/ submodule not initialised");
    return;
  }
  // Pre-existing untracked build outputs (scripts/*.a) are expected; only
  // tracked files must be clean for the revert assertion to be meaningful.
  assert.deepEqual(porcelain().tracked, [], "precondition: mame has tracked changes");

  try {
    const applied = run("apply");
    assert.equal(applied.status, 0, applied.stderr);

    const status = run("status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /applied/);

    const { tracked, untracked } = porcelain();
    for (const f of MODIFIED) {
      assert.ok(
        tracked.some((e) => e.path === f && e.code.includes("M")),
        `expected modified ${f}, got:\n${JSON.stringify(tracked)}`,
      );
    }
    for (const f of NEW_FILES) {
      assert.ok(untracked.includes(f), `expected new ${f}, got:\n${JSON.stringify(untracked)}`);
    }

    // Idempotent: a second apply must not fail or double-patch.
    const again = run("apply");
    assert.equal(again.status, 0, again.stderr);

    const reverted = run("revert");
    assert.equal(reverted.status, 0, reverted.stderr);
    const after = porcelain();
    assert.deepEqual(after.tracked, [], "revert left tracked changes in mame");
    for (const f of NEW_FILES) {
      assert.ok(!after.untracked.includes(f), `revert left ${f} in mame`);
      assert.ok(!existsSync(join(mame, f)), `revert left ${f} on disk`);
    }
    assert.match(run("status").stdout, /not applied/);
  } finally {
    run("revert"); // never leave the tree patched on failure
  }
});

test("revert on a clean tree is a no-op that exits 0", (t) => {
  if (!mameReady()) {
    t.skip("mame/ submodule not initialised");
    return;
  }
  const r = run("revert");
  assert.equal(r.status, 0, r.stderr);
});

test("every cwrap symbol in netplay_post.js is declared by the C++ module", () => {
  const glue = readFileSync(join(core, "patches", "netplay", "netplay_post.js"), "utf8");
  const header = readFileSync(join(core, "patches", "netplay", "netplay.h"), "utf8");
  const source = readFileSync(join(core, "patches", "netplay", "netplay.cpp"), "utf8");
  const decls = header + "\n" + source;
  const names = [...glue.matchAll(/cwrap\(\s*['"]([A-Za-z0-9_]+)['"]/g)].map((m) => m[1]);
  assert.ok(names.length > 0, "netplay_post.js declares no cwrap symbols");
  for (const name of names) {
    assert.match(decls, new RegExp(`\\b${name}\\b`), `no C++ declaration for ${name}`);
  }
});

test("netplay derives the start/coin player from the IPT type (T54)", () => {
  const source = readFileSync(join(core, "patches", "netplay", "netplay.cpp"), "utf8");
  // Some drivers declare START2/COIN2 without PORT_PLAYER, so field.player()
  // stays 0; the binding must read the player from the IPT type range, and both
  // the bit map and the per-player bucket must use that derived player.
  assert.match(source, /int wire_player\(ioport_field &field\)/);
  assert.match(source, /type >= IPT_START1 && type <= IPT_START10/);
  assert.match(source, /type >= IPT_COIN1 && type <= IPT_COIN12/);
  const bind = source.slice(
    source.indexOf("void build_bindings"),
    source.indexOf("Bytes the netplay snapshot"),
  );
  assert.match(bind, /int const player = wire_player\(field\)/);
  assert.match(bind, /s_fields\[player\]\[bit\]/);
});

test("netplay_read_bytes selects the byte lane for wider-than-byte spaces (T50)", () => {
  const source = readFileSync(join(core, "patches", "netplay", "netplay.cpp"), "utf8");
  const body = source.slice(source.indexOf("int netplay_read_bytes"));
  // Must mask the low address bits and pick the lane by endianness, like
  // MAME's own direct read; reading the raw get_read_ptr byte returns the low
  // byte of every 16-bit word (the T50 bug).
  assert.match(body, /lowmask/, "read_bytes must compute the native-element low mask");
  assert.match(body, /get_read_ptr\(a & ~lowmask\)/, "read_bytes must align to the native element");
  assert.match(body, /BYTE8_XOR_BE\(a\) & lowmask/, "read_bytes must pick the BE lane");
  assert.match(body, /BYTE8_XOR_LE\(a\) & lowmask/, "read_bytes must pick the LE lane");
});
