import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const repo = join(testDir, "..", "..");
const script = readFileSync(join(repo, "core", "scoremap", "watch.lua"), "utf8");

// No Lua interpreter is available in CI, so guard the parameterization (T47)
// statically: the discovery helper must stay driver-agnostic instead of
// hardcoding gridlee's CPU/space/range.
test("watch.lua reads its CPU and address window from the environment", () => {
  for (const env of [
    "WMA_WATCH_CPU",
    "WMA_WATCH_SPACE",
    "WMA_WATCH_START",
    "WMA_WATCH_END",
    "WMA_WATCH_STRIDE",
    "WMA_WATCH_LOG",
  ]) {
    assert.match(script, new RegExp(env), `missing ${env} support`);
  }
});

test("watch.lua keeps reads side-effect free", () => {
  assert.match(script, /read_direct_u8/);
});
