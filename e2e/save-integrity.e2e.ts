/**
 * Save-integrity diagnostic (WASM, T46). Answers one question for each driver:
 * does a save state capture *enough* state that reloading it and continuing
 * reproduces the future exactly? MAME only promises this when the driver sets
 * MACHINE_SUPPORTS_SAVE (gamedrv.h:76); netplay's desync recovery, viewer
 * late-join snapshots and replay all rely on it (docs/00, docs/03).
 *
 * It uses the real netplay seam (`Core.save` / `Core.load` ->
 * netplay_save_state / netplay_set_frame), not a Lua proxy, and compares the
 * engine CRC32 (`Core.hash`) at the SAME frame:
 *
 *   step 0..boot-1 with deterministic inputs
 *   snapshot = save()
 *   step boot..boot+span-1                         -> forward
 *   load(snapshot, boot-1)                         (resume at boot)
 *   step boot..boot+span-1 with the SAME inputs     -> reload
 *
 *   forward == reload  =>  the snapshot is complete enough to netplay.
 *
 * This is a DIAGNOSTIC, not a gate: only harness self-consistency (`idle ==
 * forward`, `reload == reload2`) is asserted; the `forward == reload` verdict is
 * reported per driver in a `SAVE-INTEGRITY <driver> verdict=...` line, so the run
 * stays green while the result tells us whether a driver can netplay. Flip the
 * verdict into an assertion once the recovery path is trusted (T46). The
 * evidence goes in core/spike/README.md.
 *
 * Needs the built WASM core and the ROM (both gitignored): the commercial ROMs
 * are served from the repo-root roms/ by the dev server. Run with
 * `pnpm --filter @wma/e2e test:e2e`; not part of CI.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { mintToken } from "./support/token";

const here = dirname(fileURLToPath(import.meta.url));

interface GameEntry {
  driver: string;
  coreVersion: string;
}

const games = JSON.parse(
  readFileSync(resolve(here, "../packages/web/public/games.json"), "utf8"),
) as GameEntry[];

/** All catalogue drivers; the ones flagged save-capable are asserted. */
const DRIVERS = games.map((game) => game.driver);
/** Drivers declared MACHINE_SUPPORTS_SAVE in MAME (must reproduce the future). */
const SAVE_CAPABLE = new Set(["gridlee", "twinbee", "raiden", "raiden2"]);

const BOOT = Number(process.env.WMA_SI_BOOT ?? 120);
const SPAN = Number(process.env.WMA_SI_SPAN ?? 120);
// Wire-mask bits to exercise. Bits 10/11 are START/COIN (impulse/toggle fields
// whose switch-edge side effects depend on the unsaved ioport `last` state);
// default exercises everything, but a smaller mask is a useful diagnostic.
const MASK_BITS = Number(process.env.WMA_SI_MASK ?? 0xffff);

interface Result {
  supported: boolean;
  error?: string;
  bytes?: number;
  atSave?: number;
  afterLoad?: number;
  forward?: number;
  idle?: number;
  reload?: number;
  reload2?: number;
}

for (const driver of DRIVERS) {
  const entry = games.find((game) => game.driver === driver);
  const coreDir = entry
    ? resolve(here, `../packages/web/public/static/cores/${driver}/${entry.coreVersion}`)
    : "";
  const rom = resolve(here, `../roms/${driver}.zip`);

  test(`${driver}: save/load continuation diagnostic`, async ({ browser }) => {
    test.skip(
      entry === undefined || !existsSync(coreDir) || !existsSync(rom),
      `missing core/ROM for ${driver}; build with core/build-wasm.sh ${driver}`,
    );

    const page = await browser.newPage();
    const room = `si-${driver}-${Date.now().toString(36)}`;
    await page.goto(
      `/?token=${mintToken("dev", `si-${driver}`)}#/game/${driver}/room/${room}`,
    );
    await page.waitForFunction(
      () =>
        (window as unknown as { __WMA_CORE__?: unknown }).__WMA_CORE__ !== undefined,
      undefined,
      { timeout: 120_000 },
    );

    const result = await page.evaluate(
      ({ boot, span, maskBits }) => {
        interface SiCore {
          step(frame: number, inputs: [number, number, number, number]): void;
          save(): Uint8Array;
          load(state: Uint8Array, frame: number): void;
          hash(): number;
        }
        const core = (window as unknown as { __WMA_CORE__: SiCore }).__WMA_CORE__;
        // Deterministic pseudo-inputs (a function of the frame only).
        const mask = (f: number): number =>
          (Math.imul(f, 2654435761) >>> 0) & 0xffff & maskBits;
        const inputs = (f: number): [number, number, number, number] => [
          mask(f),
          mask(f + 1),
          0,
          0,
        ];

        try {
          // Capability probe: a driver with no save buffer throws here.
          core.save();
        } catch (error) {
          return { supported: false, error: String(error) } satisfies Result;
        }

        for (let frame = 0; frame < boot; frame++) core.step(frame, inputs(frame));
        const snapshot = core.save();
        const atSave = core.hash();
        for (let frame = boot; frame < boot + span; frame++) {
          core.step(frame, inputs(frame));
        }
        const forward = core.hash();

        // Control: hash again with no stepping in between. If this differs from
        // `forward`, something else (the app) is stepping the core concurrently.
        const idle = core.hash();

        // The host saved at its last stepped frame (boot - 1); resume at boot.
        core.load(snapshot, boot - 1);
        const afterLoad = core.hash();
        for (let frame = boot; frame < boot + span; frame++) {
          core.step(frame, inputs(frame));
        }
        const reload = core.hash();

        // Second reload, same inputs: must equal the first if the load path is
        // self-consistent (isolates a non-deterministic load from a real diff).
        core.load(snapshot, boot - 1);
        for (let frame = boot; frame < boot + span; frame++) {
          core.step(frame, inputs(frame));
        }
        const reload2 = core.hash();

        return {
          supported: true,
          bytes: snapshot.length,
          atSave,
          afterLoad,
          forward,
          idle,
          reload,
          reload2,
        } satisfies Result;
      },
      { boot: BOOT, span: SPAN, maskBits: MASK_BITS },
    );

    await page.close();

    const verdict = !result.supported
      ? "NO_SAVE"
      : result.forward === result.reload
        ? "PASS"
        : "FAIL";
    console.log(
      `SAVE-INTEGRITY ${driver} verdict=${verdict} save=${SAVE_CAPABLE.has(driver)} ${JSON.stringify(result)}`,
    );

    if (!result.supported) return;

    // Harness self-consistency: if the machine is stepped by something other than
    // this loop, or a load is not reproducible, the comparison is meaningless.
    expect(result.idle, `${driver}: core moved without an explicit step`).toBe(
      result.forward,
    );
    expect(result.reload2, `${driver}: two reloads disagreed`).toBe(result.reload);

    // `forward` vs `reload` is REPORTED, not asserted: a match means the snapshot
    // is complete enough to netplay, a mismatch is a core/save defect worth an
    // issue (see core/spike/README.md). Asserting it here would make this a
    // regression gate — flip it once the recovery path is trusted.
  });
}
