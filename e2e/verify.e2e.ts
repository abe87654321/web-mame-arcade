/**
 * Native verifier golden (T47, docs/05). Intended to run the real native MAME
 * binary with `core/verify.lua` against a synthetic closed input log and assert
 * the multi-slot score read-out end to end.
 *
 * FIXME(T48): the replay path is currently non-functional — `verify.lua` passes
 * JSON to Lua `load()`, native MAME has no `json` module, and `m:input()` /
 * `m:step()` are the wrong APIs (T33 was only tested against mocked output).
 * Fixing that is T48; this spec stays `fixme` until then and is the intended
 * golden for it. The two-slot fixture (`fixtures/scoremap/gridlee-two-slot.json`)
 * is ready for that work.
 *
 * Needs the native build (`core/build-native.sh gridlee`) and the free gridlee
 * ROM (gitignored), so it is skipped in CI like the other e2e specs. The CI half
 * of the multi-slot regression is the static guard `core/test/verify-lua.test.mjs`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const DRIVER = "gridlee";
const nativeBin = join(repo, "mame", DRIVER);
const romDir = join(repo, "roms");
const romZip = join(romDir, `${DRIVER}.zip`);
const twoSlotMap = join(here, "fixtures", "scoremap", `${DRIVER}-two-slot.json`);
/** Frames to replay; a multiple of 60 so the log ends on a whole second. */
const TARGET = 300;

interface Segment {
  startFrame: number;
  endFrame: number;
  mask: number;
}
interface SlotScript {
  masks?: number[];
  segments?: Segment[];
}
interface Fixture {
  players: Record<string, SlotScript>;
}

const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "inputs", `${DRIVER}.e2e.json`), "utf8"),
) as Fixture;

function maskAt(script: SlotScript, frame: number): number {
  if (Array.isArray(script.masks)) return (script.masks[frame] ?? 0) & 0xffff;
  for (const segment of script.segments ?? []) {
    if (frame >= segment.startFrame && frame < segment.endFrame) {
      return segment.mask & 0xffff;
    }
  }
  return 0;
}

/** Build the dense closed input log for frames [0, TARGET) from the fixture. */
function buildLog(): string {
  const frames: number[][] = [];
  for (let frame = 0; frame < TARGET; frame++) {
    frames.push([
      maskAt(fixture.players["0"] ?? {}, frame),
      maskAt(fixture.players["1"] ?? {}, frame),
    ]);
  }
  return JSON.stringify({
    v: 1,
    room: "verify-e2e",
    meta: {
      driver: DRIVER,
      core_hash: "0".repeat(64),
      mame_commit: "0".repeat(40),
      rom_hash: "0".repeat(64),
      dips: {},
      mode: "coop",
    },
    start: {
      frame: 0,
      input_delay: 0,
      players: [
        { slot: 0, name: "p0" },
        { slot: 1, name: "p1" },
      ],
      start_state_key: null,
    },
    end: { frame: TARGET - 1, scores: [] },
    frames,
  });
}

/** Run the native verifier once with the given scoremap; return its stdout. */
function runVerify(scoremapPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wma-verify-"));
  const logPath = join(dir, "log.json.gz");
  writeFileSync(logPath, gzipSync(Buffer.from(buildLog())));

  const result = spawnSync(
    nativeBin,
    [
      DRIVER,
      "-video",
      "none",
      "-sound",
      "none",
      "-nothrottle",
      "-rompath",
      romDir,
      "-autoboot_script",
      "core/verify.lua",
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        VERIFY_LOG_PATH: logPath,
        VERIFY_SCOREMAP: scoremapPath,
      },
    },
  );
  if (result.error) throw result.error;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

test.describe.fixme("native verifier (T48)", () => {
  test.skip(
    !existsSync(nativeBin) || !existsSync(romZip),
    `missing native build or ROM for ${DRIVER}; run core/build-native.sh ${DRIVER}`,
  );

  test("reads every slot of a two-slot scoremap", () => {
    const out = runVerify(twoSlotMap);
    expect(out).toContain("VERIFY scoremap: 2 player slot(s)");
    expect(out).toMatch(/^SCORE 0 \d+/m);
    expect(out).toMatch(/^SCORE 1 \d+/m);
    expect(out).toContain("VERIFY DONE");
    expect(out).not.toContain("ERROR");
  });

  test("parses the committed gridlee scoremap and reads slot 0", () => {
    const out = runVerify(join(repo, "core", "scoremap", `${DRIVER}.json`));
    expect(out).toContain("VERIFY scoremap: slot=0 :maincpu/program");
    expect(out).toMatch(/^SCORE 0 \d+/m);
    expect(out).toContain("VERIFY DONE");
  });
});
