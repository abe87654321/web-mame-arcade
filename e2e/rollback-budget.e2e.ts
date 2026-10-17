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
  silentStepMs: number;
  tickMs: number;
  correction8Ms: number;
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
      ({ iters, maxWindow, budgetMs }): Budget => {
        interface ProbeCore {
          save(): Uint8Array;
          load(state: Uint8Array, frame: number): void;
          step(frame: number, inputs: readonly number[]): void;
          setSilent?(on: boolean): void;
          renderNow?(): void;
        }
        const core = (window as unknown as { __WMA_CORE__: ProbeCore }).__WMA_CORE__;
        const now = (): number => performance.now();
        const avg = (fn: () => void): number => {
          const start = now();
          for (let i = 0; i < iters; i++) fn();
          return (now() - start) / iters;
        };

        // Warm the WASM/JIT paths on the stepper first: the first frames after
        // boot include one-off compilation and are not the steady-state cost.
        const boot = core.save();
        for (let i = 0; i < 60; i++) core.step(i, [0, 0, 0, 0]);
        core.load(boot, -1);

        const bytes = boot.length;
        const saveMs = avg(() => {
          core.save();
        });

        const measureSteps = (silent: boolean): number => {
          core.load(boot, -1);
          if (silent) core.setSilent?.(true);
          const start = now();
          for (let i = 0; i < iters; i++) core.step(i, [0, 0, 0, 0]);
          const elapsed = (now() - start) / iters;
          if (silent) {
            core.setSilent?.(false);
            core.renderNow?.();
          }
          return elapsed;
        };
        const stepMs = measureSteps(false);
        // Rollback re-simulates frames the player already saw; the driver's draw
        // is read-only, so the T40 core can suppress it for those frames.
        const silentStepMs = core.setSilent ? measureSteps(true) : stepMs;

        const snapshot = core.save();
        const loadMs = avg(() => {
          core.load(snapshot, iters - 1);
        });

        // Re-simulation is incremental (one already-shown frame per tick), so
        // the steady cost is one normal/corrected step plus the per-frame save.
        const tickMs = saveMs + Math.min(stepMs, silentStepMs);
        const passes = tickMs <= budgetMs;
        return {
          bytes,
          saveMs,
          loadMs,
          stepMs,
          silentStepMs,
          tickMs,
          correction8Ms: loadMs + maxWindow * Math.min(stepMs, silentStepMs),
          suggestedWindow: passes ? maxWindow : 0,
          verdict: passes ? "PASS" : "FAIL",
        };
      },
      { iters: ITERS, maxWindow: MAX_WINDOW, budgetMs: FRAME_BUDGET_MS },
    );

    console.log(`ROLLBACK-BUDGET ${JSON.stringify({ driver, ...result })}`);
    expect(result.bytes, "empty save state").toBeGreaterThan(0);
    expect(Number.isFinite(result.saveMs)).toBe(true);
    expect(Number.isFinite(result.stepMs)).toBe(true);
  });
}
