import { describe, expect, it, vi } from "vitest";
import { loadCatalogue, seedGames, toNewGame } from "./seed";
import type { PgPool } from "./pg";

describe("seed", () => {
  it("loads the static catalogue", async () => {
    const catalogue = await loadCatalogue();
    expect(catalogue.map((entry) => entry.driver)).toContain("gridlee");
    expect(catalogue[0]!.coreVersion).toMatch(/^[0-9a-f]{64}$/);
  });

  it("projects a catalogue entry onto games columns", () => {
    const game = toNewGame({
      driver: "gridlee",
      title: "Gridlee",
      coreVersion: "c".repeat(64),
      supportsSave: true,
      netplayMode: "lockstep",
      maxPlayers: 2,
      romLicensed: true,
    });
    expect(game).toEqual({
      driver: "gridlee",
      title: "Gridlee",
      coreVersion: "c".repeat(64),
      supportsSave: true,
      netplayMode: "lockstep",
      maxPlayers: 2,
      romLicensed: true,
    });
  });

  it("upserts every catalogue entry", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return { rows: [] as unknown[] };
    });
    const pool: PgPool = { query, end: async () => {} };
    const count = await seedGames(pool, await loadCatalogue());
    expect(count).toBeGreaterThanOrEqual(1);
    expect(query).toHaveBeenCalledTimes(count);
    expect(query.mock.calls[0]![0]).toContain("INSERT INTO games");
  });
});
