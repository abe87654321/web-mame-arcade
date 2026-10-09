import { describe, expect, it } from "vitest";
import { BUTTON_BITS, PLAYER_SLOTS, RESERVED_MASK } from "./input";

describe("button bits", () => {
  it("maps each button to its contract bit", () => {
    expect(BUTTON_BITS).toEqual({
      up: 0x0001,
      down: 0x0002,
      left: 0x0004,
      right: 0x0008,
      b1: 0x0010,
      b2: 0x0020,
      b3: 0x0040,
      b4: 0x0080,
      b5: 0x0100,
      b6: 0x0200,
      start: 0x0400,
      coin: 0x0800,
    });
  });

  it("leaves bits 12-15 reserved and unused", () => {
    expect(RESERVED_MASK).toBe(0xf000);
    for (const bit of Object.values(BUTTON_BITS)) {
      expect(bit & RESERVED_MASK).toBe(0);
    }
  });

  it("never shares a bit between two buttons", () => {
    const bits = Object.values(BUTTON_BITS);
    expect(new Set(bits).size).toBe(bits.length);
  });

  it("supports four player slots", () => {
    expect(PLAYER_SLOTS).toBe(4);
  });
});
