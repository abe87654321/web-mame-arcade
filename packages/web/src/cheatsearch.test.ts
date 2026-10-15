import { describe, expect, it } from "vitest";
import { CheatSearch, readRegion, scanDecodeCombos } from "./cheatsearch";

const BCD_12345_LITTLE = [0x45, 0x23, 0x01];

describe("CheatSearch", () => {
  it("seeds candidates with every readable byte", () => {
    const search = new CheatSearch();
    search.snapshot({ base: 0x1000, bytes: Int16Array.from([1, 2, -1, 4]) });
    expect(search.count).toBe(3);
    expect(search.base).toBe(0x1000);
  });

  it("filters by exact byte value", () => {
    const search = new CheatSearch();
    search.snapshot({ base: 0x10, bytes: Int16Array.from([5, 6, 6, 7]) });
    search.filterEqual(6);
    expect(search.list().map((c) => c.addr)).toEqual([0x11, 0x12]);
  });

  it("filters changed/increased/decreased against the committed baseline", () => {
    const search = new CheatSearch();
    search.snapshot({
      base: 0x2000,
      bytes: Int16Array.from([0, 0, 10, 0, 0, 0]),
    });
    search.update({
      base: 0x2000,
      bytes: Int16Array.from([0, 5, 20, 0, 3, 0]),
    });
    search.filterChanged();
    expect(search.list().map((c) => c.addr)).toEqual([0x2001, 0x2002, 0x2004]);

    search.commit();
    search.update({
      base: 0x2000,
      bytes: Int16Array.from([0, 5, 30, 0, 1, 0]),
    });
    search.filterIncreased();
    expect(search.list().map((c) => c.addr)).toEqual([0x2002]);
  });

  it("ignores unreadable bytes in comparison filters", () => {
    const search = new CheatSearch();
    search.snapshot({ base: 0, bytes: Int16Array.from([1, -1, 3]) });
    search.update({ base: 0, bytes: Int16Array.from([9, 9, 9]) });
    search.filterChanged();
    expect(search.list().map((c) => c.addr)).toEqual([0, 2]);
  });

  it("pins a BCD score cell with filterEqualDecoded", () => {
    const search = new CheatSearch();
    search.snapshot({ base: 0x1000, bytes: new Int16Array(8) });
    const bytes = new Int16Array(8);
    bytes[2] = BCD_12345_LITTLE[0]!;
    bytes[3] = BCD_12345_LITTLE[1]!;
    bytes[4] = BCD_12345_LITTLE[2]!;
    search.update({ base: 0x1000, bytes });

    search.filterEqualDecoded(12345, { len: 3, format: "bcd", endian: "little" });
    expect(search.list().map((c) => c.addr)).toEqual([0x1002]);
    expect(Array.from(search.bytesAt(0x1002, 3) ?? [])).toEqual(BCD_12345_LITTLE);
  });
});

describe("scanDecodeCombos", () => {
  it("finds the len/format/endian that decodes to a 4-digit BCD score", () => {
    const bytes = new Int16Array(8).fill(0);
    // 1050 as 2-byte BCD little-endian: 0x50 0x10 -> "1050". The next byte is
    // non-zero so the 3-byte window does not also decode to 1050.
    bytes[2] = 0x50;
    bytes[3] = 0x10;
    bytes[4] = 0x99;
    const combos = scanDecodeCombos({ base: 0x1000, bytes }, 1050, [2, 3]);
    const hit = combos.find(
      (c) => c.len === 2 && c.format === "bcd" && c.endian === "little",
    );
    expect(hit?.count).toBeGreaterThanOrEqual(1);
    expect(hit?.samples).toContain(0x1002);

    // The wrong length (3) does not decode the same cell to 1050.
    const len3 = combos.find((c) => c.len === 3 && c.format === "bcd");
    expect(len3?.samples ?? []).not.toContain(0x1002);
  });

  it("skips unreadable bytes", () => {
    const bytes = new Int16Array([0x50, -1, 0x10]);
    const combos = scanDecodeCombos({ base: 0, bytes }, 1050, [2]);
    expect(combos.every((c) => c.count === 0)).toBe(true);
  });
});

describe("readRegion", () => {  it("reads readable ranges and marks handler-mapped holes as -1", () => {
    // Only [0x100, 0x104) is readable; everything else throws (handler-mapped).
    const readMemory = (
      _cpu: string,
      _space: string,
      addr: number,
      len: number,
    ): Uint8Array => {
      const data: number[] = [];
      for (let i = 0; i < len; i++) {
        const a = addr + i;
        if (a < 0x100 || a >= 0x104) throw new Error("no direct pointer");
        data.push(a);
      }
      return Uint8Array.from(data);
    };
    const win = {
      Module: { netplay: { readMemory } },
    } as unknown as Window;

    const snap = readRegion(win, ":maincpu", "program", 0x100, 8, 4);
    expect(Array.from(snap.bytes)).toEqual([0, 1, 2, 3, -1, -1, -1, -1]);
  });
});
