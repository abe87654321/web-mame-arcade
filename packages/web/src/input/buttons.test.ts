import { describe, expect, it } from "vitest";
import * as protocol from "@wma/protocol";
import { BUTTON_BITS, PLAYER_SLOTS, bitFor, toWireMask } from "./buttons";

describe("buttons re-export", () => {
  it("exposes the protocol bit table unchanged", () => {
    expect(BUTTON_BITS).toBe(protocol.BUTTON_BITS);
  });

  it("bitFor returns the button's contract bit", () => {
    expect(bitFor("up")).toBe(0x0001);
    expect(bitFor("b1")).toBe(0x0010);
    expect(bitFor("coin")).toBe(0x0800);
  });

  it("re-exports four player slots", () => {
    expect(PLAYER_SLOTS).toBe(4);
  });

  it("masks reserved bits off a wire value", () => {
    expect(toWireMask(0xffff)).toBe(0x0fff);
    expect(toWireMask(BUTTON_BITS.b1)).toBe(BUTTON_BITS.b1);
  });

  it("drops bits above the 16-bit mask", () => {
    expect(toWireMask(0x10000 | 0x0800)).toBe(0x0800);
  });
});
