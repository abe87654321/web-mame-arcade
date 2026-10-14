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
 * It also reports byte-level facts that separate the two failure modes behind
 * `afterLoad != atSave` / `forward != reload`: `saveStable` (save() is a pure
 * snapshot: two saves in a row agree) and `loadByteEqual` (load() is a pure
 * restore: save() right after a load re-serialises to the same bytes). If
 * `loadByteEqual` holds but `forward != reload`, the divergence is behavioural,
 * not a hash/presave artefact.
 *
 * Harness self-consistency (`idle == forward`, `reload == reload2`) is always
 * asserted. Since T46 fixed the scheduler clock bug (docs/03,
 * core/patches/netplay/0007-schedule-clock.patch) and the catalogue marks which
 * drivers are save-capable (`supportsSave`), `forward == reload` is now a
 * **regression gate** for every save-capable driver; a non-save-capable driver
 * (solo-only) is reported, not asserted. The evidence goes in
 * core/spike/README.md and the native companion is
 * core/spike/native-save-continuation.sh.
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
  supportsSave: boolean;
}

const games = JSON.parse(
  readFileSync(resolve(here, "../packages/web/public/games.json"), "utf8"),
) as GameEntry[];

/** All catalogue drivers; the save-capable ones must reproduce the future. */
const DRIVERS = games.map((game) => game.driver);
/** Catalogue source of truth: a save-capable driver must make `forward == reload`. */
const SAVE_CAPABLE = new Set(
  games.filter((game) => game.supportsSave).map((game) => game.driver),
);

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
  /** save() is idempotent: a second save with no step in between is byte-equal. */
  saveStable?: boolean;
  /** First byte offset where the two snapshots differ, or -1 when equal. */
  saveFirstDiff?: number;
  /** load(snapshot) then save() is byte-equal to the snapshot it loaded. */
  loadByteEqual?: boolean;
  /** First byte offset where the reloaded re-save differs, or -1 when equal. */
  loadFirstDiff?: number;
  /** Number of bytes that differ between the snapshot and the post-load re-save. */
  loadDiffCount?: number;
  /** Offsets of the differing bytes (capped) between snapshot and post-load re-save. */
  loadDiffOffsets?: number[];
  atSave?: number;
  afterLoad?: number;
  forward?: number;
  idle?: number;
  reload?: number;
  reload2?: number;
  /** T46 diagnostic: scheduler/frame-gate samples around save/load/step. */
  trace?: string[];
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
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("WMA_SI_")) console.log(`[${driver}] ${text}`);
    });
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
          debugInfo?(): string;
        }
        const core = (window as unknown as { __WMA_CORE__: SiCore }).__WMA_CORE__;
        const trace: string[] = [];
        const snap = (label: string): void => {
          const info = core.debugInfo?.();
          if (info !== undefined) trace.push(`${label} ${info}`);
        };
        // Deterministic pseudo-inputs (a function of the frame only).
        const mask = (f: number): number =>
          (Math.imul(f, 2654435761) >>> 0) & 0xffff & maskBits;
        const inputs = (f: number): [number, number, number, number] => [
          mask(f),
          mask(f + 1),
          0,
          0,
        ];
        // First differing byte offset, or -1 when the two buffers are equal.
        const firstDiff = (a: Uint8Array, b: Uint8Array): number => {
          const n = Math.min(a.length, b.length);
          for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
          return a.length === b.length ? -1 : n;
        };

        try {
          // Capability probe: a driver with no save buffer throws here.
          core.save();
        } catch (error) {
          return { supported: false, error: String(error) } satisfies Result;
        }

        for (let frame = 0; frame < boot; frame++) core.step(frame, inputs(frame));
        const snapshot = core.save();
        // save() runs the machine's presave callbacks (which mutate timer
        // `m_index`); a second save with no step in between must still be
        // byte-equal. If not, save() itself is not a pure snapshot.
        const snapshot2 = core.save();
        const saveFirstDiff = firstDiff(snapshot, snapshot2);
        const saveStable = saveFirstDiff === -1;
        const atSave = core.hash();
        snap("atSave");
        for (let frame = boot; frame < boot + span; frame++) {
          core.step(frame, inputs(frame));
          if (frame === boot) snap("fwd-step1");
          else if (frame === boot + 1) snap("fwd-step2");
        }
        const forward = core.hash();

        // Control: hash again with no stepping in between. If this differs from
        // `forward`, something else (the app) is stepping the core concurrently.
        const idle = core.hash();

        // The host saved at its last stepped frame (boot - 1); resume at boot.
        core.load(snapshot, boot - 1);
        snap("afterLoad");
        // Snapshot the freshly-loaded machine before any step. If this is
        // byte-equal to the snapshot we loaded, load() is a pure restore and
        // `afterLoad != atSave` is only hash/presave canonicalisation; if not,
        // the load itself loses/normalises state.
        const resaved = core.save();
        const loadFirstDiff = firstDiff(snapshot, resaved);
        const loadByteEqual = loadFirstDiff === -1;
        let loadDiffCount = 0;
        const loadDiffOffsets: number[] = [];
        for (let i = 0; i < snapshot.length; i++) {
          if (snapshot[i] !== resaved[i]) {
            loadDiffCount++;
            if (loadDiffOffsets.length < 32) loadDiffOffsets.push(i);
          }
        }
        const afterLoad = core.hash();
        for (let frame = boot; frame < boot + span; frame++) {
          core.step(frame, inputs(frame));
          if (frame === boot) snap("rel-step1");
          else if (frame === boot + 1) snap("rel-step2");
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
          saveStable,
          saveFirstDiff,
          loadByteEqual,
          loadFirstDiff,
          loadDiffCount,
          loadDiffOffsets,
          atSave,
          afterLoad,
          forward,
          idle,
          reload,
          reload2,
          trace,
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
    if (verdict === "FAIL" && result.trace) {
      for (const line of result.trace) console.log(`[${driver}] TRACE ${line}`);
    }

    if (!result.supported) return;

    // Harness self-consistency: if the machine is stepped by something other than
    // this loop, or a load is not reproducible, the comparison is meaningless.
    expect(result.idle, `${driver}: core moved without an explicit step`).toBe(
      result.forward,
    );
    expect(result.reload2, `${driver}: two reloads disagreed`).toBe(result.reload);

    // Regression gate (T46): a driver the catalogue marks save-capable must
    // reproduce the uninterrupted future after `load(save())` + same inputs.
    if (SAVE_CAPABLE.has(driver)) {
      expect(result.forward, `${driver}: reload did not reproduce the future`).toBe(
        result.reload,
      );
    }
  });
}
