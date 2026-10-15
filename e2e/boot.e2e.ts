/**
 * Boot-progress regression (T49). The black screen for raiden/raiden2 was not a
 * render bug: MAME refused to start because the local ROM zip did not match the
 * pinned commit, and it blocked on the "ROMs are incorrect / Press any key"
 * modal. play-controller still reported "running <title>" (it prints the status
 * before the machine is up), so a screenshot-only check would not have caught
 * it — but the emulated scheduler clock does not advance while MAME waits.
 *
 * This asserts the machine is genuinely executing: after the core boots, the
 * emulated time reported by `Core.debugInfo()` (T28) must increase over ~2 s of
 * real time. A frozen machine (bad ROMs, a modal, a crash) reports a constant
 * `t=` and fails. It complements core/test/rom-audit.test.mjs, which checks the
 * ROM set itself without a browser.
 *
 * Needs the built WASM core and the ROM (both gitignored), so it is skipped in
 * CI. Run: pnpm --filter @wma/e2e test:e2e -g "actually runs".
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

interface GameEntry {
  driver: string;
  title: string;
  coreVersion: string;
}

const games = JSON.parse(
  readFileSync(resolve(here, "../packages/web/public/games.json"), "utf8"),
) as GameEntry[];

/** Emulated scheduler time in seconds from `debugInfo()`, or null. */
function emuSeconds(info: string | undefined): number | null {
  const match = /t=(\d+)\.(\d+)/.exec(info ?? "");
  return match ? Number(`${match[1]}.${match[2]}`) : null;
}

interface BootedWindow {
  __WMA_CORE__?: { debugInfo?: () => string };
}

for (const game of games) {
  const coreDir = resolve(
    here,
    `../packages/web/public/static/cores/${game.driver}/${game.coreVersion}`,
  );
  const rom = resolve(here, `../roms/${game.driver}.zip`);

  test(`${game.driver}: the machine actually runs (not stuck on a ROM error)`, async ({
    page,
  }) => {
    test.skip(
      !existsSync(coreDir) || !existsSync(rom),
      `missing core/ROM for ${game.driver}; build with core/build-wasm.sh ${game.driver}`,
    );

    await page.goto(`/#/game/${game.driver}`);
    await page.waitForFunction(
      () =>
        (window as unknown as BootedWindow).__WMA_CORE__ !== undefined,
      undefined,
      { timeout: 120_000 },
    );

    const info = (): Promise<string | undefined> =>
      page.evaluate(() =>
        (window as unknown as BootedWindow).__WMA_CORE__?.debugInfo?.(),
      );

    const first = await info();
    expect(first, `${game.driver}: debugInfo() unavailable in this build`).toBeTruthy();

    await page.waitForTimeout(2_500);

    const second = await info();
    const t1 = emuSeconds(first);
    const t2 = emuSeconds(second);
    expect(t1, `${game.driver}: could not parse "${first}"`).not.toBeNull();
    expect(t2, `${game.driver}: could not parse "${second}"`).not.toBeNull();
    // The discriminator is *any* progress: a frozen machine reports an identical
    // scheduler time, a running one advances. The absolute rate varies with the
    // browser/machine (WASM MAME does not run at real time here), so a small
    // positive epsilon is all we require.
    expect(
      t2! - t1!,
      `${game.driver}: emulated time did not advance ("${first}" -> "${second}") — ` +
        "the machine is frozen (bad ROM set / warning modal / crash)",
    ).toBeGreaterThan(0.05);
  });
}
