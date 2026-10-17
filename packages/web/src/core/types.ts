/**
 * Typed emulation-core contract (T11). Netplay, viewer and score code program
 * against this interface, never against the raw Emscripten Module.
 * See docs/02-emulation-core.md and docs/contracts/core-version.md.
 */
import type { ScoreMap } from "@wma/protocol";

/** One u16 button bitmask per player slot, per docs/contracts/input-packet.md. */
export type FrameInputs = readonly [number, number, number, number];

/** CRC32 of MAME main RAM at a frame; the cross-peer desync key. */
export type StateHash = number;

export interface CoreManifest {
  driver: string;
  core_hash: string;
  mame_commit: string;
  emsdk: string;
  /** artifact filename -> sha256 (lowercase hex). */
  artifacts: Record<string, string>;
}

export interface CoreOptions {
  /** Fixed MAME command-line args; identical on every peer (docs/02). */
  readonly args: readonly string[];
  /** Directory inside the Emscripten FS where the ROM zip is mounted. */
  readonly romPath: string;
  /** Filename of the mounted ROM zip inside romPath. */
  readonly romZipName: string;
  /**
   * This driver's live-score map (T32b), or null when it has none; used by
   * `Core.readScore`.
   */
  readonly score?: ScoreMap | null;
}

export interface Core {
  /** Boot the core: mount the ROM and start MAME. Resolves when running. */
  load(): Promise<void>;
  /** Advance one emulated frame carrying that frame's inputs. Needs the T20 core. */
  step(frame: number, inputs: FrameInputs): void;
  /** Snapshot full machine state. Needs the T20 core. */
  save(): Uint8Array;
  /**
   * Restore a snapshot from save() and resync the native frame clock to
   * continue at `frame + 1` (T25 desync recovery). Called with no argument it
   * boots (see the `load()` overload above).
   */
  load(state: Uint8Array, frame: number): void;
  /** CRC32 of main RAM at the current frame. Needs the T20 core. */
  hash(): StateHash;
  /**
   * Suppress driver video rendering while rollback re-simulates frames the
   * player already saw (T40). Optional: older cores render normally.
   */
  setSilent?(on: boolean): void;
  /** Render the corrected current frame after a silent re-simulation (T40). */
  renderNow?(): void;
  /**
   * Current score for player `slot`, decoded via that driver's scoremap
   * (T32b). Throws `CoreCapabilityError` on a core/driver with no scoremap.
   */
  readScore(slot: number): number;
  /** Soft-reset the machine. */
  reset(): void;
  /** Shut the core down and release its resources. */
  destroy(): void;
}
