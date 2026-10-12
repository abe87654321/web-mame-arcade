import { describe, expect, it } from "vitest";
import { scoreMap, scoreMapEntry } from "./scoremap";

const entry = {
  slot: 0,
  cpu: ":maincpu",
  space: "program" as const,
  addr: "0x4e80",
  len: 3,
  format: "bcd" as const,
};

describe("scoremap schema", () => {
  it("accepts a well-formed map", () => {
    const map = { v: 1, players: [{ ...entry }] };
    expect(scoreMap.parse(map)).toEqual(map);
  });

  it("accepts an explicit endian", () => {
    const withEndian = { ...entry, endian: "big" as const };
    expect(scoreMapEntry.parse(withEndian)).toEqual(withEndian);
  });

  it("accepts an empty players list", () => {
    expect(scoreMap.safeParse({ v: 1, players: [] }).success).toBe(true);
  });

  it("rejects an unknown format", () => {
    expect(
      scoreMapEntry.safeParse({ ...entry, format: "hex" }).success,
    ).toBe(false);
  });

  it("rejects an unknown address space", () => {
    expect(
      scoreMapEntry.safeParse({ ...entry, space: "data" }).success,
    ).toBe(false);
  });

  it("rejects a non-hex address", () => {
    expect(
      scoreMapEntry.safeParse({ ...entry, addr: "4e80" }).success,
    ).toBe(false);
  });

  it("rejects an out-of-range length", () => {
    expect(scoreMapEntry.safeParse({ ...entry, len: 0 }).success).toBe(false);
    expect(scoreMapEntry.safeParse({ ...entry, len: 9 }).success).toBe(false);
    expect(scoreMapEntry.safeParse({ ...entry, len: 1.5 }).success).toBe(false);
  });

  it("rejects an out-of-range slot", () => {
    expect(scoreMapEntry.safeParse({ ...entry, slot: 4 }).success).toBe(false);
  });

  it("rejects extra fields (strict)", () => {
    expect(
      scoreMapEntry.safeParse({ ...entry, extra: 1 }).success,
    ).toBe(false);
    expect(
      scoreMap.safeParse({ v: 1, players: [], extra: 1 }).success,
    ).toBe(false);
  });

  it("rejects an unknown version", () => {
    expect(scoreMap.safeParse({ v: 2, players: [] }).success).toBe(false);
  });
});
