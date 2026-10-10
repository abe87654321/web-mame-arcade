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
  hash(): number;
  step(frame: number): void;
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
