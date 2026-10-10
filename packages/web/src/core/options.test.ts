import { describe, expect, it } from "vitest";
import { buildMameArgs } from "./options";

describe("buildMameArgs", () => {
  const input = { driver: "gridlee", romPath: "/roms", sessionPath: "/session" };

  it("is deterministic for the same input", () => {
    expect(buildMameArgs(input)).toEqual(buildMameArgs(input));
  });

  it("pins the determinism-critical options", () => {
    expect(buildMameArgs(input)).toEqual([
      "gridlee",
      "-rompath", "/roms",
      "-video", "bgfx",
      "-bgfx_backend", "gles",
      "-skip_gameinfo",
      "-nvram_directory", "/session",
      "-inipath", "/session",
      "-noreadconfig",
    ]);
  });

  it("appends host DIP args verbatim", () => {
    expect(buildMameArgs({ ...input, dipArgs: ["-dip", "sw1=0"] }).slice(-2)).toEqual([
      "-dip",
      "sw1=0",
    ]);
  });
});
