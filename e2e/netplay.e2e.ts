/**
 * Two-tab netplay determinism check (T26, docs/03-netplay-protocol.md). Two
 * pages join one relay room, each is fed a distinct, frame-indexed input stream
 * (the gated `window.__WMA_TEST_INPUT__` hook, T26 Task 1), the host starts the
 * match, and the harness asserts:
 *   - every per-60-frame `hash` both tabs report is identical, and
 *   - neither tab received a `desync` from the relay.
 *
 * T46 generalised this to every catalogue driver that can netplay
 * (`supportsSave && netplayMode !== "none"`); a driver without an input fixture
 * is skipped. Override the lockstep set with `WMA_E2E_DRIVERS=gridlee`.
 *
 * T40 adds the same gate for rollback. Catalogue rollback drivers run
 * automatically; a driver that has not passed the per-driver budget can still
 * be exercised with `WMA_E2E_ROLLBACK_DRIVERS=gridlee` (sets the DEV-only
 * `window.__WMA_TEST_ROLLBACK__` hook).
 *
 * Distinct per-slot streams model two players acting independently. Because the
 * masks are keyed on the frame (not on when an animation tick fired), the
 * per-frame input union is identical on both peers regardless of timing jitter,
 * so the hash streams must match. Waits are generous: MAME boot + enough frames
 * for a few hash points, which under netem can take minutes at a few fps.
 *
 * The lockstep pre-fills the first `inputDelay` frames (docs/03 "Start") with
 * mask 0, so a fixture's first non-zero mask must sit at frame >= inputDelay;
 * the gridlee fixture is zero for the first 80 frames, well clear of that window.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { collectHashes, desyncFrames } from "./support/hashes";
import { mintToken } from "./support/token";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "dev";
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

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((driver) => driver.trim())
    .filter((driver) => driver.length > 0);
}

const FORCED_ROLLBACK = new Set(list(process.env.WMA_E2E_ROLLBACK_DRIVERS));
/** Catalogue drivers that can netplay; overridable for a focused run. */
const LOCKSTEP_DRIVERS = (
  process.env.WMA_E2E_DRIVERS
    ? list(process.env.WMA_E2E_DRIVERS)
    : games
        .filter((game) => game.supportsSave && game.netplayMode === "lockstep")
        .map((game) => game.driver)
).filter((driver) => !FORCED_ROLLBACK.has(driver));

const ROLLBACK_DRIVERS = [
  ...new Set([
    ...games.filter((game) => game.netplayMode === "rollback").map((game) => game.driver),
    ...FORCED_ROLLBACK,
  ]),
];

/**
 * Wait until this tab has reported `min` per-60-frame hashes, or fail with what
 * it did report (frame list + on-screen status) so a slow/crawling netem run is
 * diagnosable rather than a bare timeout. Polling both tabs concurrently keeps
 * the total bounded by one timeout.
 */
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
      const room = (await page.locator(".lobby-status").textContent().catch(() => null)) ?? "?";
      const frames = [...hashes.keys()].sort((a, b) => a - b).join(",");
      throw new Error(
        `only ${hashes.size} hash point(s) in ${timeoutMs}ms ` +
          `(status="${status}", room="${room}", frames=[${frames}])`,
      );
    }
    await page.waitForTimeout(2000);
  }
}

function defineNetplaySuite(
  driver: string,
  mode: "lockstep" | "rollback",
): void {
  const entry = games.find((game) => game.driver === driver);
  const coreDir = entry
    ? resolve(here, `../packages/web/public/static/cores/${driver}/${entry.coreVersion}`)
    : "";
  // Commercial ROMs live in the gitignored repo-root roms/, not public/.
  const romZip = resolve(here, `../roms/${driver}.zip`);
  const fixturePath = resolve(here, `fixtures/inputs/${driver}.e2e.json`);
  const forceRollback = FORCED_ROLLBACK.has(driver);

  test.describe(`netplay ${mode}: ${driver}`, () => {
    test.skip(
      entry === undefined || !existsSync(coreDir) || !existsSync(romZip),
      `missing core/ROM for ${driver}; build with core/build-wasm.sh ${driver}`,
    );
    test.skip(
      !existsSync(fixturePath),
      `no ${driver} input fixture; add e2e/fixtures/inputs/${driver}.e2e.json`,
    );

    test("two tabs replay distinct inputs and agree on every hash", async ({ browser }) => {
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
      const room = `e2e-${driver}-${Date.now().toString(36)}`;
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
          ({ players, force }) => {
            const win = window as unknown as {
              __WMA_TEST_INPUT__?: unknown;
              __WMA_TEST_ROLLBACK__?: unknown;
            };
            win.__WMA_TEST_INPUT__ = { players };
            if (force) win.__WMA_TEST_ROLLBACK__ = true;
          },
          { players: fixture.players, force: forceRollback || mode === "rollback" },
        );
        await page.goto(`/?token=${mintToken(SECRET, sub)}#/game/${driver}/room/${room}`);
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

      await Promise.all([
        awaitHashes(p1, h1, MIN_HASHES, 300_000),
        awaitHashes(p2, h2, MIN_HASHES, 300_000),
      ]);

      expect(d1, "p1 saw a desync").toEqual([]);
      expect(d2, "p2 saw a desync").toEqual([]);

      const common = [...h1.keys()].filter((frame) => h2.has(frame)).sort((a, b) => a - b);
      expect(common.length, "no overlapping hash frames").toBeGreaterThanOrEqual(MIN_HASHES);
      for (const frame of common) {
        expect(h2.get(frame), `hash mismatch at frame ${frame}`).toBe(h1.get(frame));
      }
    });
  });
}

for (const driver of LOCKSTEP_DRIVERS) defineNetplaySuite(driver, "lockstep");
for (const driver of ROLLBACK_DRIVERS) defineNetplaySuite(driver, "rollback");
