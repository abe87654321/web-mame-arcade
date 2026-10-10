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
 * so the hash streams must match. Waits are generous: MAME boot + ~360 frames.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { collectHashes, desyncFrames } from "./support/hashes";
import { mintToken } from "./support/token";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "dev";
const DRIVER = "gridlee";
/** Require ≥ 6 hash points (frame % 60 === 0) on each tab. */
const HASH_TARGET = 360;

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

    // Both peers are seated; the host enables Start once the other is ready.
    await expect(p1.locator(".lobby-slot")).toHaveCount(2);
    await expect(p2.locator(".lobby-slot")).toHaveCount(2);

    await p2.locator(".ready-toggle").click();
    await expect(p1.locator(".start-game")).toBeEnabled();
    await p1.locator(".start-game").click();

    const reached = (hashes: Map<number, number>): number => Math.max(-1, ...hashes.keys());
    await expect
      .poll(() => reached(h1), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(HASH_TARGET);
    await expect
      .poll(() => reached(h2), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(HASH_TARGET);

    expect(d1, "p1 saw a desync").toEqual([]);
    expect(d2, "p2 saw a desync").toEqual([]);

    const common = [...h1.keys()].filter((frame) => h2.has(frame)).sort((a, b) => a - b);
    expect(common.length, "no overlapping hash frames").toBeGreaterThanOrEqual(5);
    for (const frame of common) {
      expect(h2.get(frame), `hash mismatch at frame ${frame}`).toBe(h1.get(frame));
    }
  });
});
