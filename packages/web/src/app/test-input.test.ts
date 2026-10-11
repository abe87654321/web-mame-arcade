import { describe, expect, it } from "vitest";
import { maskAt, readInputScript } from "./test-input";

describe("per-slot test input script", () => {
  it("resolves a slot's segment table and floors out-of-range frames to 0", () => {
    const script = {
      segments: [
        { startFrame: 0, endFrame: 10, mask: 0 },
        { startFrame: 10, endFrame: 20, mask: 0x08 },
      ],
    };
    expect(maskAt(script, 12)).toBe(0x08);
    expect(maskAt(script, 99)).toBe(0);
  });

  it("accepts a dense mask array and truncates to 16 bits", () => {
    expect(maskAt({ masks: [0, 0x1ffff] }, 1)).toBe(0xffff);
  });

  it("returns a different mask per slot for the same frame", () => {
    const script = readInputScript({
      __WMA_TEST_INPUT__: {
        players: {
          0: { masks: [0, 0x08] },
          1: { masks: [0, 0x04] },
        },
      },
    });
    expect(script).toBeDefined();
    expect(script!(0, 1)).toBe(0x08);
    expect(script!(1, 1)).toBe(0x04);
    expect(script!(2, 1)).toBe(0); // unseated slot
  });

  it("snapshots the script so a later global mutation cannot change inputs", () => {
    const global: { __WMA_TEST_INPUT__?: { players?: Record<string, object> } } = {
      __WMA_TEST_INPUT__: { players: { "0": { masks: [0, 0x08] } } },
    };
    const script = readInputScript(global);
    expect(script).toBeDefined();

    // Mutate both the inner array and the slot entry after arming.
    (global.__WMA_TEST_INPUT__!.players!["0"] as { masks: number[] }).masks[1] = 0x04;
    global.__WMA_TEST_INPUT__!.players!["0"] = { masks: [0, 0] };

    expect(script!(0, 1)).toBe(0x08);
  });

  it("ignores an absent or malformed global", () => {
    expect(readInputScript({})).toBeUndefined();
    expect(readInputScript({ __WMA_TEST_INPUT__: { nope: 1 } })).toBeUndefined();
    expect(readInputScript({ __WMA_TEST_INPUT__: { players: "x" } })).toBeUndefined();
  });
});
