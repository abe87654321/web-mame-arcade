import { expect, type Browser, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mintToken } from "./token";

/**
 * Shared LiveKit A/V flow (T41). Both the mock (basic) and real specs drive the
 * same UI sequence: two players reach a playing match, the host toggles Share
 * video, a viewer joins and watches, the host stops, and the viewer leaves.
 *
 * `expectVideo` lets the real spec require the video badge (proving a media
 * handshake) while the basic spec does too via the mock subscriber.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "dev";
const DRIVER = "gridlee";

interface GameEntry {
  driver: string;
  coreVersion: string;
}
const games = JSON.parse(
  readFileSync(resolve(here, "../../packages/web/public/games.json"), "utf8"),
) as GameEntry[];
const entry = games.find((g) => g.driver === DRIVER);
const coreDir = entry
  ? resolve(here, `../../packages/web/public/static/cores/${DRIVER}/${entry.coreVersion}`)
  : "";
const romZip = resolve(here, `../../packages/web/public/roms/${DRIVER}.zip`);

/** Skip reason when the gitignored core/ROM are absent, else null. */
export function missingAssets(): string | null {
  if (entry === undefined) return `no catalogue entry for ${DRIVER}`;
  if (!existsSync(coreDir) || !existsSync(romZip)) {
    return `missing core/ROM for ${DRIVER}; build with core/build-wasm.sh ${DRIVER}`;
  }
  return null;
}

/** Invoke a click handler directly (the fixed SDL canvas wins hit-testing). */
function press(page: Page, selector: string): Promise<void> {
  return page.locator(selector).evaluate((el) => (el as HTMLElement).click());
}

export async function runVideoFlow(browser: Browser): Promise<void> {
  const room = `lk-${Date.now().toString(36)}`;
  const context = await browser.newContext();
  const open = async (sub: string, href: string): Promise<Page> => {
    const page = await context.newPage();
    await page.goto(`/?token=${mintToken(SECRET, sub)}${href}`);
    return page;
  };

  const p1 = await open("lk-p1", `#/game/${DRIVER}/room/${room}`);
  const p2 = await open("lk-p2", `#/game/${DRIVER}/room/${room}`);
  await expect(p1.locator(".lobby-slot")).toHaveCount(2, { timeout: 60_000 });
  await expect(p2.locator(".lobby-slot")).toHaveCount(2, { timeout: 60_000 });

  await press(p1, ".ready-toggle");
  await press(p2, ".ready-toggle");
  const host = (await p1.locator(".start-game").count()) > 0 ? p1 : p2;
  await expect(host.locator(".start-game")).toBeEnabled({ timeout: 20_000 });
  await press(host, ".start-game");

  await expect(host.locator(".video-toggle")).toHaveText("Share video", {
    timeout: 60_000,
  });
  await press(host, ".video-toggle");
  await expect(host.locator(".video-toggle")).toHaveText("Stop video");

  // A viewer joins the playing room and records the host's A/V.
  const viewer = await open("lk-viewer", `#/game/${DRIVER}/room/${room}/watch`);
  await expect(viewer.locator(".viewer")).toBeVisible({ timeout: 60_000 });
  await expect(viewer.locator(".viewer-video")).toHaveText("video", {
    timeout: 60_000,
  });

  // The host stops sharing; the viewer's video flag clears (players leave).
  await press(host, ".video-toggle");
  await expect(host.locator(".video-toggle")).toHaveText("Share video");
  await expect(viewer.locator(".viewer-video")).toHaveCount(0, { timeout: 30_000 });

  // Lobby navigation: the viewer leaves back to the catalogue.
  await press(viewer, ".leave");
  await expect(viewer).toHaveURL(/#\/$/);
}

export { DRIVER };
