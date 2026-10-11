/**
 * Two-tab netplay determinism check (T26, docs/03-netplay-protocol.md). Two
 * pages join one relay room, each is fed a distinct, frame-indexed input stream
 * (the gated `window.__WMA_TEST_INPUT__` hook, T26 Task 1), the host starts the
 * match, and the harness asserts:
 *   - every per-60-frame `hash` both tabs report is identical, and
 *   - neither tab received a `desync` from the relay.
 *
 * Distinct per-slot streams model two players acting independently. Because the
 * masks are keyed on the frame (not on when an animation tick fired), the
 * per-frame input union is identical on both peers regardless of timing jitter,
 * so the hash streams must match. Waits are generous: MAME boot + enough frames
 * for a few hash points, which under netem can take minutes at a few fps.
 *
 * The lockstep pre-fills the first `inputDelay` frames (docs/03 "Start") with
 * mask 0, so a fixture's first non-zero mask must sit at frame >= inputDelay;
 * this fixture is zero for the first 80 frames, well clear of that window.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { collectHashes, desyncFrames } from "./support/hashes";
import { mintToken } from "./support/token";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "dev";
const DRIVER = "gridlee";
/**
 * Require this many per-60-frame hash points on each tab before comparing.
 * Deliberately a hash-point count, not a target frame: under `tc netem` the
 * headless emulator runs at only a few fps, so a high frame target times out
 * while a handful of points (frames 60, 120, 180, 240) already proves agreement.
 */
const MIN_HASHES = 4;

interface GameEntry {
  driver: string;
  coreVersion: string;
}
interface Fixture {
  driver: string;
  players: Record<string, unknown>;
}

const games = JSON.parse(
  readFileSync(resolve(here, "../packages/web/public/games.json"), "utf8"),
) as GameEntry[];
const entry = games.find((g) => g.driver === DRIVER);
const coreDir = entry
  ? resolve(here, `../packages/web/public/static/cores/${DRIVER}/${entry.coreVersion}`)
  : "";
const romZip = resolve(here, `../packages/web/public/roms/${DRIVER}.zip`);

test.describe("netplay lockstep", () => {
  test.skip(
    entry === undefined || !existsSync(coreDir) || !existsSync(romZip),
    `missing core/ROM for ${DRIVER}; build with core/build-wasm.sh ${DRIVER}`,
  );

  test("two tabs replay distinct inputs and agree on every hash", async ({ browser }) => {
    const fixture = JSON.parse(
      readFileSync(resolve(here, "fixtures/inputs/gridlee.e2e.json"), "utf8"),
    ) as Fixture;
    const room = `e2e-${Date.now().toString(36)}`;
    const context = await browser.newContext();

    const open = async (sub: string) => {
      const page = await context.newPage();
      await page.addInitScript(
        (players) => {
          (window as unknown as { __WMA_TEST_INPUT__?: unknown }).__WMA_TEST_INPUT__ = {
            players,
          };
        },
        fixture.players,
      );
      await page.goto(`/?token=${mintToken(SECRET, sub)}#/game/${DRIVER}/room/${room}`);
      return page;
    };

    const p1 = await open("e2e-p1");
    const p2 = await open("e2e-p2");
    const h1 = collectHashes(p1);
    const h2 = collectHashes(p2);
    const d1 = desyncFrames(p1);
    const d2 = desyncFrames(p2);

    // Both peers are seated. The SDL canvas is `position: fixed` and wins the
    // headless hit-test over the lobby overlay, so invoke a button's click
    // handler directly instead of a coordinate click.
    // Generous: a cold WASM boot under a shaped loop can be slow.
    await expect(p1.locator(".lobby-slot")).toHaveCount(2, { timeout: 60_000 });
    await expect(p2.locator(".lobby-slot")).toHaveCount(2, { timeout: 60_000 });

    const press = (page: Page, selector: string): Promise<void> =>
      page.locator(selector).evaluate((el) => (el as HTMLElement).click());

    // Both players ready up (canStart ignores the host's own flag).
    await press(p1, ".ready-toggle");
    await press(p2, ".ready-toggle");

    // Join order is a race, so do not assume p1 is host: the host is the tab
    // (lowest slot) that carries the Start button, exactly one of the two.
    const startButtons = async (): Promise<number> =>
      (await p1.locator(".start-game").count()) +
      (await p2.locator(".start-game").count());
    await expect.poll(startButtons, { timeout: 20_000 }).toBe(1);
    const host = (await p1.locator(".start-game").count()) > 0 ? p1 : p2;
    await expect(host.locator(".start-game")).toBeEnabled();
    await press(host, ".start-game");

    await expect
      .poll(() => h1.size, { timeout: 300_000 })
      .toBeGreaterThanOrEqual(MIN_HASHES);
    await expect
      .poll(() => h2.size, { timeout: 300_000 })
      .toBeGreaterThanOrEqual(MIN_HASHES);

    expect(d1, "p1 saw a desync").toEqual([]);
    expect(d2, "p2 saw a desync").toEqual([]);

    const common = [...h1.keys()].filter((frame) => h2.has(frame)).sort((a, b) => a - b);
    expect(common.length, "no overlapping hash frames").toBeGreaterThanOrEqual(MIN_HASHES);
    for (const frame of common) {
      expect(h2.get(frame), `hash mismatch at frame ${frame}`).toBe(h1.get(frame));
    }
  });
});
