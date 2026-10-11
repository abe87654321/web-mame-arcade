/**
 * T28 WASM save/load/hash spike (docs/tasks/README.md). Boots the netplay-armed
 * core in a page (a room route arms it, so the machine is frozen at frame 0),
 * then times save()/load()/hash() and checks a save -> load round-trip restores
 * the same state hash. The numbers are the client budget a T40 rollback ring
 * would spend per frame; the report lives in core/spike/README.md.
 *
 * Needs the built WASM core and ROM (gitignored): `core/build-wasm.sh gridlee`.
 * Run with `pnpm --filter @wma/e2e test:spike`; it is not part of CI.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { mintToken } from "./support/token";

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER = "gridlee";
const ITERS = 50;

interface GameEntry {
  driver: string;
  coreVersion: string;
}

const games = JSON.parse(
  readFileSync(resolve(here, "../packages/web/public/games.json"), "utf8"),
) as GameEntry[];
const entry = games.find((game) => game.driver === DRIVER);
const coreDir = entry
  ? resolve(here, `../packages/web/public/static/cores/${DRIVER}/${entry.coreVersion}`)
  : "";
const romZip = resolve(here, `../packages/web/public/roms/${DRIVER}.zip`);

test.describe("wasm save/load/hash spike", () => {
  test.skip(
    entry === undefined || !existsSync(coreDir) || !existsSync(romZip),
    `missing core/ROM for ${DRIVER}; build with core/build-wasm.sh ${DRIVER}`,
  );

  test("measures the state cost and round-trip determinism", async ({ browser }) => {
    const page = await browser.newPage();
    const room = `spike-${Date.now().toString(36)}`;
    // A room route arms the netplay core at boot; a token is required for the
    // app to wire netplay at all (the relay is started by the e2e config).
    await page.goto(`/?token=${mintToken("dev", "spike")}#/game/${DRIVER}/room/${room}`);

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

    const result = await page.evaluate((iters: number) => {
      interface SpikeCore {
        save(): Uint8Array;
        load(state: Uint8Array, frame: number): void;
        hash(): number;
      }
      const core = (window as unknown as { __WMA_CORE__: SpikeCore }).__WMA_CORE__;
      const clock = (): number => performance.now();
      const avg = (fn: () => void): number => {
        const start = clock();
        for (let i = 0; i < iters; i++) fn();
        return (clock() - start) / iters;
      };

      core.hash(); // warm up
      const bytes = core.save().length;
      const saveMs = avg(() => {
        core.save();
      });
      const hashMs = avg(() => {
        core.hash();
      });
      const snapshot = core.save();
      const loadMs = avg(() => {
        core.load(snapshot, 0);
      });

      const before = core.hash();
      core.load(core.save(), 0);
      const after = core.hash();
      return { bytes, saveMs, hashMs, loadMs, before, after };
    }, ITERS);

    console.log(`SPIKE ${JSON.stringify(result)}`);
    expect(result.bytes, "empty save state").toBeGreaterThan(0);
    expect(result.after, "save -> load round-trip changed the state hash").toBe(
      result.before,
    );
  });
});
