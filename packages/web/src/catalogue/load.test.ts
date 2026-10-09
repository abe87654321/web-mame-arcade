import { describe, expect, it, vi } from "vitest";
import { loadCatalogue } from "./load";

const entry = {
  driver: "gridlee",
  title: "Gridlee",
  coreVersion: "a".repeat(64),
  mameCommit: "b".repeat(40),
  supportsSave: true,
  netplayMode: "lockstep",
  maxPlayers: 2,
  romLicensed: true,
  coreBaseUrl: "/static/cores/gridlee",
  romZipUrl: "/roms/gridlee.zip",
};

describe("loadCatalogue", () => {
  it("fetches and parses the catalogue", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [entry],
    }));
    const games = await loadCatalogue("/games.json", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/games.json");
    expect(games).toEqual([entry]);
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => [],
    }));
    await expect(loadCatalogue("/games.json", fetchImpl)).rejects.toThrow(
      /404/,
    );
  });

  it("propagates invalid catalogue content", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [{ driver: "" }],
    }));
    await expect(loadCatalogue("/games.json", fetchImpl)).rejects.toThrow(
      /driver/,
    );
  });
});
