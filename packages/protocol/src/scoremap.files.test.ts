import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseScoreMap } from "./scoremap";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scoremapDir = join(repoRoot, "core", "scoremap");

/**
 * T47: the local-dev drivers that must ship a scoremap. `raiden`/`raiden2` are
 * not listed yet — their WASM cores render a black screen (T49), so their
 * scoremaps are blocked and tracked there.
 */
const REQUIRED_DRIVERS = ["twinbee", "twincobr"] as const;

/**
 * Guards the committed data files (not just the schema): every
 * `core/scoremap/*.json` must parse, and the T47 drivers must be present with a
 * slot-0 entry. A malformed or missing file fails here before it can reach the
 * browser loader or the native verifier.
 */
describe("committed scoremaps (core/scoremap/*.json)", () => {
  const files = readdirSync(scoremapDir).filter((file) => file.endsWith(".json"));

  it("every committed file parses against the scoreMap schema", () => {
    for (const file of files) {
      const map = parseScoreMap(
        JSON.parse(readFileSync(join(scoremapDir, file), "utf8")),
      );
      expect(map.v).toBe(1);
      expect(map.players.length).toBeGreaterThan(0);
    }
  });

  it.each(REQUIRED_DRIVERS)("ships a %s scoremap with a slot-0 entry", (driver) => {
    const map = parseScoreMap(
      JSON.parse(readFileSync(join(scoremapDir, `${driver}.json`), "utf8")),
    );
    expect(map.players.some((player) => player.slot === 0)).toBe(true);
  });
});
