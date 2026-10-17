/**
 * T40 rollback budget probe. Boots each catalogue driver's frozen netplay core
 * in a room route and measures the per-frame cost a rollback ring spends:
 * `save()` every frame and up to `window` re-simulated frames per correction.
 *
 * The suggested window is the largest w in [2, 8] for which
 * `saveMs + w * stepMs <= 16 ms`. A driver whose smallest window still does not
 * fit is not enabled for rollback. Results are indicative (one machine, warmed
 * JIT); record them in `core/spike/README.md`.
 *
 * Needs the built WASM core and ROM (both gitignored). Run with
 * `pnpm --filter @wma/e2e test:rollback-budget`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { mintToken } from "./support/token";

const here = dirname(fileURLToPath(import.meta.url));
const ITERS = 20;
const FRAME_BUDGET_MS = 16;
const MIN_WINDOW = 2;
const MAX_WINDOW = 8;

interface GameEntry {
  driver: string;
  coreVersion: string;
}

const games = JSON.parse(
  readFileSync(resolve(here, "../packages/web/public/games.json"), "utf8"),
) as GameEntry[];

interface Budget {
  bytes: number;
  saveMs: number;
  loadMs: number;
  stepMs: number;
  windowMs: number;
  worstMs: number;
  suggestedWindow: number;
  verdict: "PASS" | "FAIL";
}

for (const entry of games) {
  const { driver } = entry;
  const coreDir = resolve(
    here,
    `../packages/web/public/static/cores/${driver}/${entry.coreVersion}`,
  );
  const rom = resolve(here, `../roms/${driver}.zip`);

  test(`${driver}: rollback frame budget`, async ({ browser }) => {
    test.skip(
      !existsSync(coreDir) || !existsSync(rom),
      `missing core/ROM for ${driver}; build with core/build-wasm.sh ${driver}`,
    );

    const page = await browser.newPage();
    const room = `rollback-budget-${driver}-${Date.now().toString(36)}`;
    // A room route arms the netplay core at boot, so it stays frozen until we
    // drive `Core.step` ourselves.
    await page.goto(
      `/?token=${mintToken("dev", "rollback-budget")}#/game/${driver}/room/${room}`,
    );

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

    const result = await page.evaluate(
      ({ iters, minWindow, maxWindow, budgetMs }): Budget => {
        interface ProbeCore {
          save(): Uint8Array;
          load(state: Uint8Array, frame: number): void;
          step(frame: number, inputs: readonly number[]): void;
        }
        const core = (window as unknown as { __WMA_CORE__: ProbeCore }).__WMA_CORE__;
        const now = (): number => performance.now();
        const avg = (fn: () => void): number => {
          const start = now();
          for (let i = 0; i < iters; i++) fn();
          return (now() - start) / iters;
        };

        const bytes = core.save().length;
        const saveMs = avg(() => {
          core.save();
        });

        const stepStart = now();
        for (let i = 0; i < iters; i++) core.step(i, [0, 0, 0, 0]);
        core.save(); // let the JIT settle on the final state
        const stepMs = (now() - stepStart) / iters;

        const snapshot = core.save();
        const loadMs = avg(() => {
          core.load(snapshot, iters - 1);
        });

        let suggestedWindow = 0;
        for (let window = maxWindow; window >= minWindow; window--) {
          if (saveMs + window * stepMs <= budgetMs) {
            suggestedWindow = window;
            break;
          }
        }
        return {
          bytes,
          saveMs,
          loadMs,
          stepMs,
          windowMs: saveMs + maxWindow * stepMs,
          worstMs: saveMs + loadMs + maxWindow * stepMs,
          suggestedWindow,
          verdict: suggestedWindow >= minWindow ? "PASS" : "FAIL",
        };
      },
      { iters: ITERS, minWindow: MIN_WINDOW, maxWindow: MAX_WINDOW, budgetMs: FRAME_BUDGET_MS },
    );

    console.log(`ROLLBACK-BUDGET ${JSON.stringify({ driver, ...result })}`);
    expect(result.bytes, "empty save state").toBeGreaterThan(0);
    expect(Number.isFinite(result.saveMs)).toBe(true);
    expect(Number.isFinite(result.stepMs)).toBe(true);
  });
}
