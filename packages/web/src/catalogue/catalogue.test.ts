import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    romHash: HEX64,
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

  it("rejects a bad rom hash", () => {
    expect(() => parseCatalogue([valid({ romHash: "abc" })])).toThrow(/romHash/);
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

describe("committed catalogue (packages/web/public/games.json)", () => {
  const games = parseCatalogue(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../public/games.json", import.meta.url)),
        "utf8",
      ),
    ),
  );

  it("parses and lists the expected drivers", () => {
    expect(games.map((game) => game.driver)).toEqual([
      "gridlee",
      "twinbee",
      "raiden",
      "raiden2",
      "twincobr",
    ]);
  });

  it("marks the commercial ROMs unlicensed for local-dev only", () => {
    for (const driver of ["twinbee", "raiden", "raiden2", "twincobr"]) {
      expect(findGame(games, driver)?.romLicensed).toBe(false);
    }
    expect(findGame(games, "gridlee")?.romLicensed).toBe(true);
  });

  it("catalogues twincobr as solo-only (no MACHINE_SUPPORTS_SAVE)", () => {
    const twinCobra = findGame(games, "twincobr");
    expect(twinCobra?.supportsSave).toBe(false);
    expect(twinCobra?.netplayMode).toBe("none");
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
