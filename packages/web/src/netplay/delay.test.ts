import { describe, expect, it } from "vitest";
import { selectInputDelay } from "./delay";

describe("selectInputDelay", () => {
  it("floors at the minimum with no peers or zero RTT", () => {
    expect(selectInputDelay([])).toBe(2);
    expect(selectInputDelay([0, 0])).toBe(2);
  });

  it("sizes the delay from the worst measured RTT", () => {
    // ceil(90 / 16.67) + 1 = 7, clamped to the 6-frame cap.
    expect(selectInputDelay([90, 40])).toBe(6);
    // ceil(40 / 16.67) + 1 = 4, between min and max.
    expect(selectInputDelay([40])).toBe(4);
  });

  it("respects explicit bounds and frame duration", () => {
    expect(selectInputDelay([40], { min: 1, max: 3 })).toBe(3);
    // A 10 ms frame: ceil(40 / 10) + 1 = 5.
    expect(selectInputDelay([40], { frameMs: 10, max: 8 })).toBe(5);
  });

  it("ignores non-finite and negative readings", () => {
    expect(selectInputDelay([Number.NaN, -5, Number.POSITIVE_INFINITY])).toBe(2);
  });
});
