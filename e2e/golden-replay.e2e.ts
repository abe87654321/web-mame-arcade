/**
 * Golden replay (T29, docs/DEVELOPMENT.md "Golden replays are your best tests").
 * Boots the frozen netplay core in a room route (armed but unstepped, so the
 * manual `core.step` loop is the only thing advancing the machine), replays the
 * committed per-slot input fixture to a fixed frame and reads the engine CRC32
 * (`netplay_hash`). It compares that to a committed golden
 * (`e2e/fixtures/golden/<driver>.json`) so any change to the core build or the
 * input-replay path that alters the simulation is caught.
 *
 * T46 generalised this to every catalogue driver that can netplay
 * (`supportsSave && netplayMode === "lockstep"`): gridlee, twinbee, ... A driver
 * without a fixture or a golden is skipped, so the suite runs as soon as one
 * driver is recorded. Override the set with `WMA_E2E_DRIVERS=gridlee,twinbee`.
 *
 * This is the e2e half of the T29 regression: the fast half is the committed
 * step-trace golden in `packages/web/src/netplay/lockstep.test.ts`, which needs
 * no build. Both regenerate only with an intentional emulation-path change.
 *
 * Needs the built WASM core and ROM (gitignored, commercial ROMs live in the
 * repo-root `roms/`), so it is skipped in CI. To record a golden once the core
 * exists: run this test, copy the `crc32` it logs into
 * `e2e/fixtures/golden/<driver>.json` (with the matching `coreHash` and `frame`),
 * and review the diff. Run with `pnpm --filter @wma/e2e test:e2e`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { mintToken } from "./support/token";

const here = dirname(fileURLToPath(import.meta.url));
/** Frame to replay to. A multiple of 60 so the hash is a lockstep boundary. */
const TARGET = 300;

interface GameEntry {
  driver: string;
  coreVersion: string;
  supportsSave: boolean;
  netplayMode: string;
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

/** Catalogue drivers that can netplay; overridable for a focused run. */
const DRIVERS = (
  process.env.WMA_E2E_DRIVERS
    ? process.env.WMA_E2E_DRIVERS.split(",")
    : games
        .filter((game) => game.supportsSave && game.netplayMode === "lockstep")
        .map((game) => game.driver)
).map((driver) => driver.trim()).filter((driver) => driver.length > 0);

for (const driver of DRIVERS) {
  const entry = games.find((game) => game.driver === driver);
  const coreDir = entry
    ? resolve(here, `../packages/web/public/static/cores/${driver}/${entry.coreVersion}`)
    : "";
  // Commercial ROMs live in the gitignored repo-root roms/, not public/.
  const romZip = resolve(here, `../roms/${driver}.zip`);
  const fixturePath = resolve(here, `fixtures/inputs/${driver}.e2e.json`);
  const goldenPath = resolve(here, `fixtures/golden/${driver}.json`);
  const fixture = existsSync(fixturePath)
    ? (JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture)
    : null;
  const golden = existsSync(goldenPath)
    ? (JSON.parse(readFileSync(goldenPath, "utf8")) as {
        coreHash: string;
        frame: number;
        crc32: number;
      })
    : null;

  test.describe(`golden replay: ${driver}`, () => {
    test.skip(
      entry === undefined || !existsSync(coreDir) || !existsSync(romZip),
      `missing core/ROM for ${driver}; build with core/build-wasm.sh ${driver}`,
    );
    test.skip(
      fixture === null,
      `no ${driver} input fixture; add e2e/fixtures/inputs/${driver}.e2e.json`,
    );
    test.skip(
      golden === null,
      `no ${driver} golden yet; run this test and record e2e/fixtures/golden/${driver}.json`,
    );

    test("the frozen core reproduces the committed final hash", async ({ browser }) => {
      const page = await browser.newPage();
      const room = `golden-${driver}-${Date.now().toString(36)}`;
      // A room route boots the core with netplay armed (frozen at frame 0); no
      // game.start is sent, so the lockstep never runs and this evaluate loop is
      // the sole driver of `core.step`.
      await page.goto(`/?token=${mintToken("dev", "golden")}#/game/${driver}/room/${room}`);

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
        { target: TARGET, players: fixture?.players ?? {} },
      );

      console.log(`GOLDEN ${driver} frame=${TARGET} crc32=${crc32}`);
      expect(golden?.frame).toBe(TARGET);
      expect(crc32, "final hash differs from the committed golden").toBe(golden?.crc32);
    });
  });
}
