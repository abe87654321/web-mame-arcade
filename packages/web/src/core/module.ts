/**
 * Structural surface of the stock MAME Emscripten build used by the wrapper.
 * Mirrors the globals from the generated .js plus JSMAME from
 * mame/scripts/resources/emscripten/emscripten_post.js.
 */

export interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
}

export interface JsMame {
  save(name: string): void;
  load(name: string): void;
  soft_reset(): void;
  hard_reset(): void;
  exit(): void;
}

/**
 * Ergonomic JS-side hooks provided ONLY by the T20 netplay build. T20's glue
 * wraps the raw `netplay_*` C ABI from core/patches into this shape; the stock
 * build leaves `CoreModule.netplay` undefined.
 */
export interface NetplayHooks {
  /**
   * Arm the frame gate. Call as soon as the core is loaded (before the first
   * main-loop tick) so the machine freezes at boot; safe before the machine
   * exists — activation is retried on the first tick (T24, docs/03).
   */
  enable(): void;
  setInputs(frame: number, p1: number, p2: number, p3: number, p4: number): void;
  saveState(): Uint8Array;
  loadState(state: Uint8Array): void;
  /**
   * Resync the native frame clock after `loadState` restored a snapshot at
   * `frame`: resume stepping at `frame + 1` and drop inputs already stepped
   * (T25 desync recovery, docs/03).
   */
  setFrame(frame: number): void;
  hash(): number;
  step(frame: number): void;
  /**
   * Read `len` bytes of emulated memory from a CPU device's address space
   * (T32b score reads): `cpu` is a device tag (":maincpu"), `space` a MAME
   * address-space name ("program"/"io"). A pure read; it never steps the
   * machine. Provided only by the T32b core build.
   */
  readMemory(cpu: string, space: string, addr: number, len: number): Uint8Array;
  /** T46 diagnostic: one-line scheduler/frame-gate state; empty on older cores. */
  info?(): string;
}

export interface CoreModule {
  FS: EmscriptenFS;
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  JSMAME: JsMame;
  /** Set only when the core was built from the T20 netplay patch. */
  netplay?: NetplayHooks;
  [runtimeMethod: string]: unknown;
}
