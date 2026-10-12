/**
 * Golden replay (T29, docs/DEVELOPMENT.md "Golden replays are your best tests").
 * Boots the frozen netplay core in a room route (armed but unstepped, so the
 * manual `core.step` loop is the only thing advancing the machine), replays the
 * committed per-slot input fixture to a fixed frame and reads the engine CRC32
 * (`netplay_hash`). It compares that to a committed golden
 * (`e2e/fixtures/golden/<driver>.json`) so any change to the core build or the
 * input-replay path that alters the simulation is caught.
 *
 * This is the e2e half of the T29 regression: the fast half is the committed
 * step-trace golden in `packages/web/src/netplay/lockstep.test.ts`, which needs
 * no build. Both regenerate only with an intentional emulation-path change.
 *
 * Needs the built WASM core and ROM (gitignored), so it is skipped in CI. To
 * record the golden once the core exists: run this test, copy the `crc32` it
 * logs into `e2e/fixtures/golden/gridlee.json` (with the matching `coreHash`
 * and `frame`), and review the diff. Run with `pnpm --filter @wma/e2e test:e2e`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { mintToken } from "./support/token";

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER = "gridlee";
/** Frame to replay to. A multiple of 60 so the hash is a lockstep boundary. */
const TARGET = 300;

interface GameEntry {
  driver: string;
  coreVersion: string;
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
  readFileSync(resolve(here, "fixtures/inputs/gridlee.e2e.json"), "utf8"),
) as Fixture;
const goldenPath = resolve(here, `fixtures/golden/${DRIVER}.json`);
const golden = existsSync(goldenPath)
  ? (JSON.parse(readFileSync(goldenPath, "utf8")) as {
      coreHash: string;
      frame: number;
      crc32: number;
    })
  : null;

test.describe("golden replay", () => {
  test.skip(
    entry === undefined || !existsSync(coreDir) || !existsSync(romZip),
    `missing core/ROM for ${DRIVER}; build with core/build-wasm.sh ${DRIVER}`,
  );
  test.skip(
    golden === null,
    `no ${DRIVER} golden yet; run this test and record e2e/fixtures/golden/${DRIVER}.json`,
  );

  test("the frozen core reproduces the committed final hash", async ({ browser }) => {
    const page = await browser.newPage();
    const room = `golden-${Date.now().toString(36)}`;
    // A room route boots the core with netplay armed (frozen at frame 0); no
    // game.start is sent, so the lockstep never runs and this evaluate loop is
    // the sole driver of `core.step`.
    await page.goto(`/?token=${mintToken("dev", "golden")}#/game/${DRIVER}/room/${room}`);

    await page.waitForFunction(
      () => {
        const core = (window as unknown as { __WMA_CORE__?: { save(): Uint8Array } })
          .__WMA_CORE__;
        try {
          return core !== undefined && core.save().length > 0;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 120_000 },
    );

    const crc32 = await page.evaluate(
      ({ target, players }) => {
        interface ReplayCore {
          step(frame: number, inputs: [number, number, number, number]): void;
          hash(): number;
        }
        const core = (window as unknown as { __WMA_CORE__: ReplayCore }).__WMA_CORE__;
        const maskAt = (script: SlotScript, frame: number): number => {
          if (Array.isArray(script.masks)) return (script.masks[frame] ?? 0) & 0xffff;
          for (const segment of script.segments ?? []) {
            if (frame >= segment.startFrame && frame < segment.endFrame) {
              return segment.mask & 0xffff;
            }
          }
          return 0;
        };
        for (let frame = 0; frame < target; frame++) {
          core.step(frame, [
            maskAt(players["0"] ?? {}, frame),
            maskAt(players["1"] ?? {}, frame),
            0,
            0,
          ]);
        }
        return core.hash();
      },
      { target: TARGET, players: fixture.players },
    );

    console.log(`GOLDEN ${DRIVER} frame=${TARGET} crc32=${crc32}`);
    expect(golden?.frame).toBe(TARGET);
    expect(crc32, "final hash differs from the committed golden").toBe(golden?.crc32);
  });
});
