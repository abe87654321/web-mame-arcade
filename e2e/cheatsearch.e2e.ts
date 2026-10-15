/**
 * Cheat-search dev tool smoke (T47). Boots the real gridlee WASM core in the
 * browser, opens the play page with `?cheatsearch=1`, and asserts the panel
 * installs and can snapshot program RAM through the core's `readMemory` hook.
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

  test("installs and snapshots program RAM", async ({ page }) => {
    await page.goto("/?cheatsearch=1#/game/gridlee");

    const panel = page.locator('[data-wma-cheatsearch="1"]');
    await expect(panel).toBeVisible();

    // Wait for the core to finish booting: readMemory needs the runtime up.
    await page.waitForFunction(
      () => Boolean((window as unknown as { __WMA_CORE__?: unknown }).__WMA_CORE__),
      undefined,
      { timeout: 120_000 },
    );

    // The SDL canvas swallows Playwright's synthetic pointer events, so drive
    // the panel in-page (the real user clicks it directly).
    await page.waitForTimeout(2000);
    const count = await page.evaluate(() => {
      const panel = document.querySelector('[data-wma-cheatsearch="1"]');
      const reset = Array.from(panel?.querySelectorAll("button") ?? []).find((b) =>
        /Reset/.test(b.textContent ?? ""),
      );
      (reset as HTMLButtonElement | undefined)?.click();
      const status = Array.from(panel?.querySelectorAll("div") ?? []).find((d) =>
        /^candidates: \d+$/.test(d.textContent ?? ""),
      );
      return Number((status?.textContent ?? "").replace(/\D/g, ""));
    });
    expect(count).toBeGreaterThan(0);

    // On-screen keypad works without the keyboard, and Pause toggles.
    const ui = await page.evaluate(() => {
      const panel = document.querySelector('[data-wma-cheatsearch="1"]');
      const btns = Array.from(panel?.querySelectorAll("button") ?? []);
      const byText = (t: string): HTMLButtonElement | undefined =>
        btns.find((b) => (b.textContent ?? "").trim() === t);
      byText("7")?.click();
      byText("8")?.click();
      const score = panel?.querySelectorAll("input")[0] as HTMLInputElement;
      const scoreVal = score.value;
      byText("Pause game")?.click();
      const pausedLabel = byText("Resume game")?.textContent ?? "";
      return { scoreVal, pausedLabel };
    });
    expect(ui.scoreVal).toBe("78");
    expect(ui.pausedLabel).toContain("Resume");
  });
});
