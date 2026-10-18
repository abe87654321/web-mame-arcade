/**
 * Three-player lockstep gate (T53). The two-tab suite proves a pair agrees;
 * this one proves the same start barrier and per-frame input table scale to a
 * third peer (the case T53 called out: "it does not scale to >2 players").
 *
 * Three tabs join one room, ready up, the lowest-slot host starts, and every
 * per-60-frame hash must be identical on all three. The input fixture's third
 * slot is optional (`readInputScript` treats a missing slot as mask 0), so the
 * gate can run with the existing per-driver fixtures.
 *
 * Needs the built WASM core and the ROM (both gitignored). Not part of CI.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { collectHashes, desyncFrames } from "./support/hashes";
import { mintToken } from "./support/token";

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER = process.env.WMA_E2E_3P_DRIVER ?? "gridlee";
/** Four points (60..240) balances evidence against a slow headless boot. */
const MIN_HASHES = 4;

interface GameEntry {
  driver: string;
  coreVersion: string;
  supportsSave: boolean;
  netplayMode: string;
}
interface Fixture {
  driver: string;
  players: Record<string, unknown>;
}

const games = JSON.parse(
  readFileSync(resolve(here, "../packages/web/public/games.json"), "utf8"),
) as GameEntry[];
const entry = games.find((game) => game.driver === DRIVER);
const coreDir = entry
  ? resolve(here, `../packages/web/public/static/cores/${DRIVER}/${entry.coreVersion}`)
  : "";
const romZip = resolve(here, `../roms/${DRIVER}.zip`);
const fixturePath = resolve(here, `fixtures/inputs/${DRIVER}.e2e.json`);

async function awaitHashes(
  page: Page,
  hashes: Map<number, number>,
  min: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (hashes.size < min) {
    if (Date.now() > deadline) {
      const status = (await page.locator(".status").textContent().catch(() => null)) ?? "?";
      const room =
        (await page.locator(".lobby-status").textContent().catch(() => null)) ?? "?";
      const frames = [...hashes.keys()].sort((a, b) => a - b).join(",");
      throw new Error(
        `only ${hashes.size} hash point(s) in ${timeoutMs}ms ` +
          `(status="${status}", room="${room}", frames=[${frames}])`,
      );
    }
    await page.waitForTimeout(2000);
  }
}

test.describe(`netplay lockstep: ${DRIVER} (3 players)`, () => {
  test.skip(
    entry === undefined || !existsSync(coreDir) || !existsSync(romZip),
    `missing core/ROM for ${DRIVER}; build with core/build-wasm.sh ${DRIVER}`,
  );
  test.skip(
    !existsSync(fixturePath),
    `no ${DRIVER} input fixture; add e2e/fixtures/inputs/${DRIVER}.e2e.json`,
  );

  test("three tabs agree on every hash", async ({ browser }) => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
    const room = `e2e3p-${DRIVER}-${Date.now().toString(36)}`;
    const context = await browser.newContext();

    const open = async (sub: string) => {
      const page = await context.newPage();
      page.on("console", (message) => {
        const text = message.text();
        if (text.includes("[netplay]") || message.type() === "error") {
          console.log(`[${sub}]`, text);
        }
      });
      await page.addInitScript(
        ({ players }) => {
          (window as unknown as { __WMA_TEST_INPUT__?: unknown }).__WMA_TEST_INPUT__ =
            { players };
        },
        { players: fixture.players },
      );
      await page.goto(
        `/?token=${mintToken("dev", sub)}#/game/${DRIVER}/room/${room}`,
      );
      return page;
    };

    const pages = [await open("e2e3p-p1"), await open("e2e3p-p2"), await open("e2e3p-p3")];
    try {
      const hashes = pages.map((page) => collectHashes(page));
      const desyncs = pages.map((page) => desyncFrames(page));

      for (const page of pages) {
        await expect(page.locator(".lobby-slot")).toHaveCount(3, { timeout: 60_000 });
      }

      const press = (page: Page, selector: string): Promise<void> =>
        page.locator(selector).evaluate((el) => (el as HTMLElement).click());

      // Every player readies up; the host's own flag does not gate the start.
      for (const page of pages) await press(page, ".ready-toggle");

      const startButtons = async (): Promise<number> =>
        (
          await Promise.all(
            pages.map((page) => page.locator(".start-game").count()),
          )
        ).reduce((sum, count) => sum + count, 0);
      await expect.poll(startButtons, { timeout: 20_000 }).toBe(1);
      const host = (
        await Promise.all(
          pages.map((page) => page.locator(".start-game").count()),
        )
      ).findIndex((count) => count > 0);
      await expect(pages[host]!.locator(".start-game")).toBeEnabled();
      await press(pages[host]!, ".start-game");

      await Promise.all(
        pages.map((page, i) => awaitHashes(page, hashes[i]!, MIN_HASHES, 300_000)),
      );

      for (const [i, frames] of desyncs.entries()) {
        expect(frames, `p${i + 1} saw a desync`).toEqual([]);
      }

      const common = [...hashes[0]!.keys()]
        .filter((frame) => hashes.every((map) => map.has(frame)))
        .sort((a, b) => a - b);
      expect(common.length, "no overlapping hash frames").toBeGreaterThanOrEqual(
        MIN_HASHES,
      );
      for (const frame of common) {
        const expected = hashes[0]!.get(frame);
        for (let i = 1; i < hashes.length; i++) {
          expect(
            hashes[i]!.get(frame),
            `p${i + 1} hash mismatch at frame ${frame}`,
          ).toBe(expected);
        }
      }
    } finally {
      await context.close();
    }
  });
});
