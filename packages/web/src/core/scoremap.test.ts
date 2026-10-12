import { describe, expect, it, vi } from "vitest";
import { decodeScore, loadScoreMap } from "./scoremap";

function entry(overrides: Partial<Parameters<typeof decodeScore>[1]> = {}) {
  return {
    slot: 0,
    cpu: ":maincpu",
    space: "program" as const,
    addr: "0x4e80",
    len: 3,
    format: "bcd" as const,
    ...overrides,
  };
}

describe("decodeScore", () => {
  it("decodes little-endian BCD (most-significant byte first)", () => {
    // 12345 stored little-endian as 45 23 01 -> "012345" -> 12345.
    const bytes = new Uint8Array([0x45, 0x23, 0x01]);
    expect(decodeScore(bytes, entry({ format: "bcd", endian: "little" }))).toBe(12345);
  });

  it("defaults to little-endian for BCD", () => {
    const bytes = new Uint8Array([0x45, 0x23, 0x01]);
    expect(decodeScore(bytes, entry({ format: "bcd" }))).toBe(12345);
  });

  it("decodes big-endian BCD in address order", () => {
    const bytes = new Uint8Array([0x01, 0x23, 0x45]);
    expect(decodeScore(bytes, entry({ format: "bcd", endian: "big" }))).toBe(12345);
  });

  it("decodes a little-endian binary integer", () => {
    const bytes = new Uint8Array([0x39, 0x30, 0x00]); // 0x003039 = 12345
    expect(decodeScore(bytes, entry({ format: "binary", endian: "little", len: 3 }))).toBe(
      12345,
    );
  });

  it("decodes a big-endian binary integer", () => {
    const bytes = new Uint8Array([0x00, 0x30, 0x39]);
    expect(decodeScore(bytes, entry({ format: "binary", endian: "big", len: 3 }))).toBe(
      12345,
    );
  });

  it("decodes a single-byte score", () => {
    expect(decodeScore(new Uint8Array([0x42]), entry({ format: "binary", len: 1 }))).toBe(
      0x42,
    );
  });

  it("reads all-zero as 0", () => {
    expect(decodeScore(new Uint8Array([0, 0, 0]), entry({ format: "bcd" }))).toBe(0);
  });

  it("rejects a byte length that differs from the entry", () => {
    expect(() => decodeScore(new Uint8Array([0x45, 0x23]), entry({ len: 3 }))).toThrow(
      /length/,
    );
  });

  it("rejects an invalid BCD nibble", () => {
    expect(() => decodeScore(new Uint8Array([0x4f, 0x23, 0x01]), entry({ format: "bcd" })))
      .toThrow(/BCD/);
  });

  it("rejects a value above Number.MAX_SAFE_INTEGER", () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() =>
      decodeScore(bytes, entry({ format: "binary", len: 8 })),
    ).toThrow(/MAX_SAFE_INTEGER/);
  });
});

describe("loadScoreMap", () => {
  const valid = {
    v: 1,
    players: [
      { slot: 0, cpu: ":maincpu", space: "program", addr: "0x4e80", len: 3, format: "bcd" },
    ],
  };

  it("parses a valid scoremap", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => valid }));
    expect(await loadScoreMap("/static/scoremap/gridlee.json", fetchImpl)).toEqual(valid);
    expect(fetchImpl).toHaveBeenCalledWith("/static/scoremap/gridlee.json");
  });

  it("treats a 404 as 'no scoremap' (undefined), not an error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(await loadScoreMap("/static/scoremap/none.json", fetchImpl)).toBeUndefined();
  });

  it("rejects a non-404 fetch failure", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(loadScoreMap("/x.json", fetchImpl)).rejects.toThrow(/500/);
  });

  it("rejects a malformed scoremap", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ v: 1, players: [{ slot: 0 }] }),
    }));
    await expect(loadScoreMap("/x.json", fetchImpl)).rejects.toThrow();
  });

  it("does not fetch when given no URL", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => valid }));
    expect(await loadScoreMap(undefined, fetchImpl)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
