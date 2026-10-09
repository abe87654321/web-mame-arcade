/**
 * Build the MAME command line. It must be byte-identical on every peer
 * (docs/02, contracts/core-version.md): only the driver and the two session
 * paths vary per room. Nothing here reads the clock, locale, randomness or
 * environment, so the same input always yields the same array.
 */
export interface MameArgsInput {
  driver: string;
  romPath: string;
  /** Per-session directory for NVRAM and INI so no host state leaks in. */
  sessionPath: string;
  /** Extra DIP-switch args from the room host, appended verbatim. */
  dipArgs?: readonly string[];
}

export function buildMameArgs(input: MameArgsInput): string[] {
  const args = [
    input.driver,
    "-rompath", input.romPath,
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
