/**
 * Cross-instance determinism probe (T53). Two browser tabs boot the *same*
 * netplay-armed core and are stepped directly with identical, frame-indexed
 * inputs. No relay, no RTC, no lockstep: this isolates the emulation/boot
 * invariant from the netplay start path.
 *
 * Why this exists: the two-tab lockstep e2e was intermittently desyncing
 * (`jackal`, `rygar`, ...), and a one-off two-page probe suggested that two
 * independently booted cores could already disagree. If boot is deterministic,
 * stepping both with the same inputs must produce the same hash stream; if it
 * is not, the bug is in boot/arming, not in the lockstep loop.
 *
 * The pages join separate rooms only so the app arms netplay (`netplay: true`)
 * and exposes `window.__WMA_CORE__`; the match is never started, so nothing
 * else steps the core. This is a *diagnostic*, opt-in with `WMA_TWO_CORE=1`:
 * some drivers (rygar, jackal) have a boot save buffer that already differs
 * across tabs, which the real match neutralises by loading the host's boot
 * snapshot (T53); the two-tab lockstep e2e is the shipping gate.
 * `WMA_TWO_CORE_DRIVERS` overrides the driver set and `WMA_TWO_CORE_FRAMES`
 * the step count (default 240, four 60-frame points).
 *
 * Needs the built WASM core and the ROM (both gitignored). Not part of CI.
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
  netplayMode: string;
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

/** Default to the drivers T53 observed diverging (plus references). */
const DEFAULT_DRIVERS = [
  "gridlee",
  "commando",
  "jackal",
  "rygar",
  "tankfrce",
  "geminij",
  "raiden2",
];
const DRIVERS = list(process.env.WMA_TWO_CORE_DRIVERS).length
  ? list(process.env.WMA_TWO_CORE_DRIVERS)
  : DEFAULT_DRIVERS;
const FRAMES = Number(process.env.WMA_TWO_CORE_FRAMES ?? 240);

interface CoreProbe {
  bootInfo: string;
  bootHash: number;
  hashes: { frame: number; hash: number }[];
  /** Full boot save buffer; only returned when WMA_TWO_CORE_DUMP=1. */
  save?: number[];
}

/**
 * Step a frozen core directly with deterministic inputs and return its boot
 * evidence plus a hash at every 60th stepped frame. Runs inside the page.
 */
function probeCore(args: { frames: number; dump: boolean }): CoreProbe {
  interface ProbeCore {
    step(frame: number, inputs: [number, number, number, number]): void;
    hash(): number;
    save(): Uint8Array;
    debugInfo?(): string;
  }
  const core = (window as unknown as { __WMA_CORE__: ProbeCore }).__WMA_CORE__;
  if (!core) throw new Error("__WMA_CORE__ is missing");
  const { frames, dump } = args;
  // A mask that depends only on the frame, so both pages feed the same values.
  const mask = (frame: number): number =>
    Math.imul(frame, 2654435761) >>> 0;
  const bootInfo = core.debugInfo?.() ?? "";
  const bootHash = core.hash();
  const save = dump ? Array.from(core.save()) : undefined;
  const hashes: { frame: number; hash: number }[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const m = mask(frame) & 0xffff;
    core.step(frame, [m, (m >>> 3) & 0xffff, 0, 0]);
    if (frame > 0 && frame % 60 === 0) {
      hashes.push({ frame, hash: core.hash() });
    }
  }
  return { bootInfo, bootHash, hashes, ...(save ? { save } : {}) };
}

for (const driver of DRIVERS) {
  const entry = games.find((game) => game.driver === driver);
  const coreDir = entry
    ? resolve(here, `../packages/web/public/static/cores/${driver}/${entry.coreVersion}`)
    : "";
  const romZip = resolve(here, `../roms/${driver}.zip`);

  test(`${driver}: two cores stay byte-identical from frame 0`, async ({ browser }) => {
    test.skip(
      process.env.WMA_TWO_CORE !== "1",
      "diagnostic probe; set WMA_TWO_CORE=1 to run",
    );
    test.skip(
      entry === undefined || !existsSync(coreDir) || !existsSync(romZip),
      `missing core/ROM for ${driver}; build with core/build-wasm.sh ${driver}`,
    );

    const context = await browser.newContext();
    const open = async (sub: string) => {
      const page = await context.newPage();
      page.on("console", (message) => {
        const text = message.text();
        if (text.includes("[netplay]") || message.type() === "error") {
          console.log(`[two-core ${sub}]`, text);
        }
      });
      // Separate rooms: the probe drives the cores itself; the app must only
      // arm netplay and expose the core.
      const room = `two-core-${driver}-${sub}-${Date.now().toString(36)}`;
      await page.goto(
        `/?token=${mintToken("dev", `two-core-${driver}-${sub}`)}` +
          `#/game/${driver}/room/${room}`,
      );
      await page.waitForFunction(
        () =>
          (window as unknown as { __WMA_CORE__?: unknown }).__WMA_CORE__ !==
          undefined,
        undefined,
        { timeout: 120_000 },
      );
      return page;
    };

    const p1 = await open("p1");
    const p2 = await open("p2");
    try {
      const dump = process.env.WMA_TWO_CORE_DUMP === "1";
      const [a, b] = await Promise.all([
        p1.evaluate(probeCore, { frames: FRAMES, dump }),
        p2.evaluate(probeCore, { frames: FRAMES, dump }),
      ]);

      if (a.save && b.save) {
        const offsets: number[] = [];
        let diffCount = 0;
        const n = Math.min(a.save.length, b.save.length);
        for (let i = 0; i < n; i++) {
          if (a.save[i] !== b.save[i]) {
            diffCount++;
            if (offsets.length < 32) offsets.push(i);
          }
        }
        console.log(
          `TWO-CORE ${driver} saveBytes=${a.save.length}/${b.save.length} ` +
            `diffCount=${diffCount} firstDiffs=[${offsets.join(",")}]`,
        );
      }

      const detail = `driver=${driver} bootA={${a.bootInfo}} bootB={${b.bootInfo}}`;
      expect(a.bootHash, `boot state differs (${detail})`).toBe(b.bootHash);
      if (a.bootInfo && b.bootInfo) {
        expect(a.bootInfo, `boot frame/clock differs (${detail})`).toBe(b.bootInfo);
      }
      expect(a.hashes.length, "not enough hash points").toBeGreaterThanOrEqual(1);
      for (let i = 0; i < a.hashes.length; i++) {
        const pa = a.hashes[i]!;
        const pb = b.hashes[i]!;
        expect(pb.frame, `hash frame sequence differs (${detail})`).toBe(pa.frame);
        expect(
          pb.hash,
          `hash mismatch at frame ${pa.frame} (${detail})`,
        ).toBe(pa.hash);
      }
    } finally {
      await context.close();
    }
  });
}
