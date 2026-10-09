import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUT_CONFIG,
  playerBindings,
  type InputConfig,
} from "./bindings";
import { findConflicts, sameDevice } from "./devices";

const pad0 = { kind: "gamepad", index: 0 } as const;

describe("sameDevice", () => {
  it("matches identical devices and rejects others", () => {
    expect(sameDevice(pad0, { kind: "gamepad", index: 0 })).toBe(true);
    expect(sameDevice(pad0, { kind: "gamepad", index: 1 })).toBe(false);
    expect(sameDevice(pad0, { kind: "keyboard" })).toBe(false);
  });
});

describe("findConflicts", () => {
  it("returns nothing for the default room", () => {
    expect(findConflicts(DEFAULT_INPUT_CONFIG)).toEqual([]);
  });

  it("reports a device assigned to two slots", () => {
    const room: InputConfig = {
      ...DEFAULT_INPUT_CONFIG,
      devices: [pad0, { kind: "gamepad", index: 0 }, null, null],
    };
    expect(findConflicts(room)).toEqual([
      { kind: "device", device: pad0, slots: [0, 1] },
    ]);
  });

  it("reports one binding on two buttons of the same player", () => {
    const players = [...DEFAULT_INPUT_CONFIG.players];
    players[0] = playerBindings({
      b1: [{ kind: "key", code: "KeyZ" }],
      b2: [{ kind: "key", code: "KeyZ" }],
    });
    const room: InputConfig = { ...DEFAULT_INPUT_CONFIG, players };
    expect(findConflicts(room)).toEqual([
      {
        kind: "binding",
        slot: 0,
        binding: { kind: "key", code: "KeyZ" },
        buttons: ["b1", "b2"],
      },
    ]);
  });

  it("does not flag the same key on different players", () => {
    const players = [...DEFAULT_INPUT_CONFIG.players];
    players[1] = playerBindings({ b1: [{ kind: "key", code: "Digit1" }] });
    const room: InputConfig = { ...DEFAULT_INPUT_CONFIG, players };
    expect(findConflicts(room)).toEqual([]);
  });
});
