/**
 * Cheat-search dev tool smoke (T47). Boots the real gridlee WASM core in the
 * browser, opens the play page with `?cheatsearch=1`, and asserts the panel
 * installs, is hit-testable above the (blocked-from-fullscreen) canvas, and can
 * snapshot program RAM through the core's `readMemory` hook.
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

  test("installs, is hit-testable, and snapshots program RAM", async ({ page }) => {
    await page.goto("/?cheatsearch=1#/game/gridlee");

    const panel = page.locator('[data-wma-cheatsearch="1"]');
    await expect(panel).toBeVisible();

    // Wait for the core to finish booting: readMemory needs the runtime up.
    await page.waitForFunction(
      () => Boolean((window as unknown as { __WMA_CORE__?: unknown }).__WMA_CORE__),
      undefined,
      { timeout: 120_000 },
    );

    // The game's fullscreen request is blocked while the tool is armed, so the
    // panel is not covered by the canvas's top layer.
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null), {
        timeout: 15_000,
      })
      .toBe(true);

    // A click at the Reset button's centre lands on the panel, not the canvas.
    const onTop = await page.evaluate(() => {
      const panelEl = document.querySelector('[data-wma-cheatsearch="1"]')!;
      const btn = Array.from(panelEl.querySelectorAll("button")).find((b) =>
        /Reset/.test(b.textContent ?? ""),
      )!;
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      return panelEl.contains(hit);
    });
    expect(onTop).toBe(true);

    // Drive the buttons in-page (the canvas rAF loop stalls Playwright's own
    // synthetic clicks); the panel's click handlers are what we are testing.
    const count = await clickAndCount(page, "Reset");
    expect(count).toBeGreaterThan(0);

    await click(page, "7");
    await click(page, "8");
    expect(await firstInputValue(page)).toBe("78");

    await click(page, "Pause game");
    expect(await hasButton(page, "Resume game")).toBe(true);
  });
});

async function click(
  page: import("@playwright/test").Page,
  label: string,
): Promise<void> {
  const ok = await page.evaluate((text) => {
    const panel = document.querySelector('[data-wma-cheatsearch="1"]');
    const btn = Array.from(panel?.querySelectorAll("button") ?? []).find(
      (b) => (b.textContent ?? "").trim() === text,
    ) as HTMLButtonElement | undefined;
    btn?.click();
    return Boolean(btn);
  }, label);
  if (!ok) throw new Error(`no button "${label}"`);
}

async function clickAndCount(
  page: import("@playwright/test").Page,
  label: string,
): Promise<number> {
  const match = await page.evaluate((text) => {
    const panel = document.querySelector('[data-wma-cheatsearch="1"]');
    return Array.from(panel?.querySelectorAll("button") ?? []).find((b) =>
      (b.textContent ?? "").includes(text),
    )
      ? true
      : false;
  }, label);
  if (!match) throw new Error(`no button contains "${label}"`);
  await page.evaluate((text) => {
    const panel = document.querySelector('[data-wma-cheatsearch="1"]');
    const btn = Array.from(panel?.querySelectorAll("button") ?? []).find((b) =>
      (b.textContent ?? "").includes(text),
    ) as HTMLButtonElement | undefined;
    btn?.click();
  }, label);
  return page.evaluate(() => {
    const panel = document.querySelector('[data-wma-cheatsearch="1"]');
    const div = Array.from(panel?.querySelectorAll("div") ?? []).find((d) =>
      /^candidates: \d+$/.test(d.textContent ?? ""),
    );
    return Number((div?.textContent ?? "").replace(/\D/g, ""));
  });
}

async function firstInputValue(
  page: import("@playwright/test").Page,
): Promise<string> {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-wma-cheatsearch="1"]');
    return (panel?.querySelector("input") as HTMLInputElement | null)?.value ?? "";
  });
}

async function hasButton(
  page: import("@playwright/test").Page,
  label: string,
): Promise<boolean> {
  return page.evaluate((text) => {
    const panel = document.querySelector('[data-wma-cheatsearch="1"]');
    return Array.from(panel?.querySelectorAll("button") ?? []).some(
      (b) => (b.textContent ?? "").trim() === text,
    );
  }, label);
}
