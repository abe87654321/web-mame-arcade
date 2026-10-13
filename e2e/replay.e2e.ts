/**
 * Closed-log replay golden (T35). Builds an `InputLog` from the committed
 * per-slot input fixture, gzips it, serves it from the API replay route via a
 * Playwright route, opens `#/game/<driver>/replay/<key>` and lets the replay
 * controller step the frozen core. When the replay reaches its last frame the
 * core's CRC32 (`netplay_hash`) must equal the same committed golden the
 * lockstep replay uses (`e2e/fixtures/golden/<driver>.json`), so any change to
 * the closed-log decode/step path that alters the simulation is caught.
 *
 * Needs the built WASM core and ROM (gitignored), so it is skipped in CI. The
 * fixture log is generated here from `fixtures/inputs/<driver>.e2e.json` so the
 * input source stays single.
 */
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER = "gridlee";
/** Frames to replay; matches golden-replay.e2e.ts (hash after frame 299). */
const TARGET = 300;

interface GameEntry {
  driver: string;
  coreVersion: string;
  mameCommit: string;
  romHash: string;
}
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

const games = JSON.parse(
  readFileSync(resolve(here, "../packages/web/public/games.json"), "utf8"),
) as GameEntry[];
const entry = games.find((game) => game.driver === DRIVER);
const coreDir = entry
  ? resolve(here, `../packages/web/public/static/cores/${DRIVER}/${entry.coreVersion}`)
  : "";
const romZip = resolve(here, `../packages/web/public/roms/${DRIVER}.zip`);
const fixture = JSON.parse(
  readFileSync(resolve(here, `fixtures/inputs/${DRIVER}.e2e.json`), "utf8"),
) as Fixture;
const goldenPath = resolve(here, `fixtures/golden/${DRIVER}.json`);
const golden = existsSync(goldenPath)
  ? (JSON.parse(readFileSync(goldenPath, "utf8")) as {
      coreHash: string;
      frame: number;
      crc32: number;
    })
  : null;

function maskAt(script: SlotScript, frame: number): number {
  if (Array.isArray(script.masks)) return (script.masks[frame] ?? 0) & 0xffff;
  for (const segment of script.segments ?? []) {
    if (frame >= segment.startFrame && frame < segment.endFrame) {
      return segment.mask & 0xffff;
    }
  }
  return 0;
}

/** Build the dense closed log for frames [0, TARGET) from the fixture. */
function buildLog(game: GameEntry): string {
  const frames: number[][] = [];
  for (let frame = 0; frame < TARGET; frame++) {
    frames.push([
      maskAt(fixture.players["0"] ?? {}, frame),
      maskAt(fixture.players["1"] ?? {}, frame),
    ]);
  }
  return JSON.stringify({
    v: 1,
    room: "golden",
    meta: {
      driver: DRIVER,
      core_hash: game.coreVersion,
      mame_commit: game.mameCommit,
      rom_hash: game.romHash,
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

test.describe("closed-log replay", () => {
  test.skip(
    entry === undefined || !existsSync(coreDir) || !existsSync(romZip),
    `missing core/ROM for ${DRIVER}; build with core/build-wasm.sh ${DRIVER}`,
  );
  test.skip(
    golden === null,
    `no ${DRIVER} golden; run golden-replay.e2e.ts and record e2e/fixtures/golden/${DRIVER}.json`,
  );

  test("replays a served input log to the committed hash", async ({ browser }) => {
    if (!entry) throw new Error(`no catalogue entry for ${DRIVER}`);
    if (!golden) throw new Error(`no golden for ${DRIVER}`);
    const page = await browser.newPage();
    const key = "match/golden/replay.json.gz";
    const gz = new Uint8Array(gzipSync(Buffer.from(buildLog(entry))));

    // Serve the artifact from the API's replay route without a running API.
    await page.route("**/api/replays/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/gzip",
        body: Buffer.from(gz),
      }),
    );

    await page.goto(`/#/game/${DRIVER}/replay/${encodeURIComponent(key)}`);

    await page.waitForFunction(
      (expected) => {
        const core = (window as unknown as { __WMA_CORE__?: { hash(): number } })
          .__WMA_CORE__;
        if (!core) return false;
        try {
          return core.hash() === expected;
        } catch {
          return false;
        }
      },
      golden.crc32,
      { timeout: 120_000 },
    );

    console.log(`REPLAY ${DRIVER} key=${key} crc32=${golden.crc32}`);
    expect(golden.frame).toBe(TARGET);
  });
});
