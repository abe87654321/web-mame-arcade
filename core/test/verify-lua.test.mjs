import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const repo = join(testDir, "..", "..");
const script = readFileSync(join(repo, "core", "verify.lua"), "utf8");

// No Lua interpreter is available in CI, so guard the multi-slot replay
// behaviour statically. The live end-to-end proof is `e2e/verify.e2e.ts`
// (needs the native build + gridlee ROM, skipped in CI); these assertions catch
// a regression back to reading only the first scoremap entry.
test("verify.lua parses every entry of the scoremap players array", () => {
  assert.match(script, /body:gmatch\("%b\{\}"\)/);
  assert.match(script, /players\[#players \+ 1\]/);
});

test("verify.lua reads every scoremap slot, not just the first", () => {
  assert.match(script, /scoremap\.players/);
  assert.match(script, /for _, entry in ipairs\(slots_to_read\)/);
});

test("verify.lua honours each entry's cpu and space", () => {
  assert.match(script, /entry\.cpu/);
  assert.match(script, /entry\.space/);
});

test("verify.lua reads RAM side-effect free", () => {
  assert.match(script, /read_direct_u8/);
});
