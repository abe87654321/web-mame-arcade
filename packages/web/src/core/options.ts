/**
 * Build the MAME command line. The flag sequence is fixed; every peer must pass
 * the same values for `driver`, `romPath` and `sessionPath` so the line is
 * byte-identical across the room (docs/02, contracts/core-version.md).
 * `sessionPath` is a directory inside the Emscripten FS (not a host path) that
 * must be fresh and empty, so no per-machine NVRAM/INI state leaks into
 * emulation. `dipArgs` must already be canonical (fixed order, from room state)
 * because DIP settings are a determinism-critical input. Nothing here reads the
 * clock, locale, randomness or environment, so the same input always yields the
 * same array.
 */
export interface MameArgsInput {
  driver: string;
  romPath: string;
  /** Fresh, empty in-FS directory for NVRAM and INI so no host state leaks in. */
  sessionPath: string;
  /** Canonical DIP-switch args from the room host, appended verbatim. */
  dipArgs?: readonly string[];
}

export function buildMameArgs(input: MameArgsInput): string[] {
  const args = [
    input.driver,
    "-rompath", input.romPath,
    // The Emscripten/SDL OSD has a desktop-GL renderer (glShadeModel, absent in
    // WebGL) and a bgfx one with Emscripten (essl/WebGL) shaders embedded; force
    // bgfx so video works under WebGL. Fixed value, so peers stay byte-identical.
    "-video", "bgfx",
    "-skip_gameinfo",
    "-nvram_directory", input.sessionPath,
    "-inipath", input.sessionPath,
    "-noreadconfig",
  ];
  if (input.dipArgs) {
    args.push(...input.dipArgs);
  }
  return args;
}
