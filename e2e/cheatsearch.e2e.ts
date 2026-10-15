/**
 * Cheat-search dev tool smoke (T47). Boots the real gridlee WASM core in the
 * browser, opens the play page with `?cheatsearch=1`, and asserts the panel
 * installs, is clickable (the game runs fullscreen, so the panel must leave it),
 * and can snapshot program RAM through the core's `readMemory` hook.
 *
 * Needs the built WASM core and ROM (gitignored), so it is skipped in CI like
 * the other e2e specs. Run: pnpm --filter @wma/e2e test:e2e -g "cheat search".
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER = "gridlee";

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

test.describe("cheat search panel", () => {
  test.skip(
    entry === undefined || !existsSync(coreDir) || !existsSync(romZip),
    `missing core/ROM for ${DRIVER}; build with core/build-wasm.sh ${DRIVER}`,
  );

  test("installs, is clickable, and snapshots program RAM", async ({ page }) => {
    await page.goto("/?cheatsearch=1#/game/gridlee");

    const panel = page.locator('[data-wma-cheatsearch="1"]');
    await expect(panel).toBeVisible();

    // Wait for the core to finish booting: readMemory needs the runtime up.
    await page.waitForFunction(
      () => Boolean((window as unknown as { __WMA_CORE__?: unknown }).__WMA_CORE__),
      undefined,
      { timeout: 120_000 },
    );

    // `?cheatsearch=1` must have taken the game out of the fullscreen top layer.
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);

    // Real pointer click (would time out if the fullscreen canvas still covered
    // the panel).
    await panel.getByRole("button", { name: /Reset/ }).click();

    const status = panel.locator("div").filter({ hasText: /^candidates: \d+$/ });
    await expect(status).toContainText(/candidates: \d+/);
    const count = Number((await status.textContent())?.replace(/\D/g, ""));
    expect(count).toBeGreaterThan(0);

    // On-screen keypad works without the keyboard (the game captures keys).
    await panel.getByRole("button", { name: "7", exact: true }).click();
    await panel.getByRole("button", { name: "8", exact: true }).click();
    await expect(panel.locator("input").first()).toHaveValue("78");

    // Pause toggles.
    await panel.getByRole("button", { name: /Pause game/ }).click();
    await expect(panel.getByRole("button", { name: /Resume game/ })).toBeVisible();
  });
});
