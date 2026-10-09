/**
 * Typed emulation-core contract (T11). Netplay, viewer and score code program
 * against this interface, never against the raw Emscripten Module.
 * See docs/02-emulation-core.md and docs/contracts/core-version.md.
 */

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
}

export interface Core {
  /** Boot the core: mount the ROM and start MAME. Resolves when running. */
  load(): Promise<void>;
  /** Advance one emulated frame carrying that frame's inputs. Needs the T20 core. */
  step(frame: number, inputs: FrameInputs): void;
  /** Snapshot full machine state. Needs the T20 core. */
  save(): Uint8Array;
  /** Restore a snapshot from save(), or boot when called with no argument. */
  load(state: Uint8Array): void;
  /** CRC32 of main RAM at the current frame. Needs the T20 core. */
  hash(): StateHash;
  /** Current player-1 score. Needs T32 (scoremap). */
  readScore(): number;
  /** Soft-reset the machine. */
  reset(): void;
  /** Shut the core down and release its resources. */
  destroy(): void;
}
