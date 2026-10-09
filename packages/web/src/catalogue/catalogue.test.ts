import { describe, expect, it } from "vitest";
import { findGame, parseCatalogue } from "./catalogue";

const HEX40 = "b".repeat(40);
const HEX64 = "a".repeat(64);

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    driver: "gridlee",
    title: "Gridlee",
    coreVersion: HEX64,
    mameCommit: HEX40,
    supportsSave: true,
    netplayMode: "lockstep",
    maxPlayers: 2,
    romLicensed: true,
    coreBaseUrl: "/static/cores/gridlee",
    romZipUrl: "/roms/gridlee.zip",
    ...overrides,
  };
}

describe("parseCatalogue", () => {
  it("accepts a valid catalogue", () => {
    expect(parseCatalogue([valid()])).toEqual([valid()]);
  });

  it("rejects a non-array value", () => {
    expect(() => parseCatalogue({ games: [] })).toThrow(/array/);
  });

  it("rejects a non-object entry", () => {
    expect(() => parseCatalogue(["nope"])).toThrow(/object/);
  });

  it("rejects an empty driver", () => {
    expect(() => parseCatalogue([valid({ driver: "" })])).toThrow(/driver/);
  });

  it("rejects a non-hex core version", () => {
    expect(() => parseCatalogue([valid({ coreVersion: "xyz" })])).toThrow(
      /coreVersion/,
    );
  });

  it("rejects a bad mame commit", () => {
    expect(() => parseCatalogue([valid({ mameCommit: "abc" })])).toThrow(
      /mameCommit/,
    );
  });

  it("rejects an unknown netplay mode", () => {
    expect(() =>
      parseCatalogue([valid({ netplayMode: "peer" })]),
    ).toThrow(/netplayMode/);
  });

  it("rejects a non-positive maxPlayers", () => {
    expect(() => parseCatalogue([valid({ maxPlayers: 0 })])).toThrow(
      /maxPlayers/,
    );
  });

  it("rejects non-boolean flags", () => {
    expect(() => parseCatalogue([valid({ supportsSave: "yes" })])).toThrow(
      /supportsSave/,
    );
    expect(() => parseCatalogue([valid({ romLicensed: 1 })])).toThrow(
      /romLicensed/,
    );
  });

  it("rejects empty URLs", () => {
    expect(() => parseCatalogue([valid({ coreBaseUrl: "" })])).toThrow(
      /coreBaseUrl/,
    );
    expect(() => parseCatalogue([valid({ romZipUrl: "" })])).toThrow(
      /romZipUrl/,
    );
  });

  it("rejects duplicate drivers so lookups stay unambiguous", () => {
    expect(() => parseCatalogue([valid(), valid()])).toThrow(/duplicate/);
  });
});

describe("findGame", () => {
  const entries = parseCatalogue([valid()]);

  it("returns the matching entry", () => {
    expect(findGame(entries, "gridlee")?.title).toBe("Gridlee");
  });

  it("returns undefined for an unknown driver", () => {
    expect(findGame(entries, "pacman")).toBeUndefined();
  });
});
