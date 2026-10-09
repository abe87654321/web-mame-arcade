import { describe, expect, it } from "vitest";
import { BUTTON_BITS, type Button } from "@wma/protocol";
import {
  BINDINGS_VERSION,
  DEFAULT_GAMEPAD_BINDINGS,
  DEFAULT_KEYBOARD_BINDINGS,
  DEFAULT_ROOM_BINDINGS,
  emptyFrameInputs,
  playerBindings,
} from "./bindings";

describe("playerBindings", () => {
  it("leaves every button unbound by default", () => {
    const p = playerBindings({});
    for (const button of Object.keys(BUTTON_BITS) as Button[]) {
      expect(p[button]).toEqual([]);
    }
  });

  it("overrides only the buttons it is given", () => {
    const p = playerBindings({ b1: [{ kind: "key", code: "KeyZ" }] });
    expect(p.b1).toEqual([{ kind: "key", code: "KeyZ" }]);
    expect(p.b2).toEqual([]);
  });
});

describe("default bindings", () => {
  it("uses MAME-style start/coin keys on the keyboard", () => {
    expect(DEFAULT_KEYBOARD_BINDINGS.start).toEqual([
      { kind: "key", code: "Digit1" },
    ]);
    expect(DEFAULT_KEYBOARD_BINDINGS.coin).toEqual([
      { kind: "key", code: "Digit5" },
    ]);
  });

  it("maps the standard gamepad layout", () => {
    expect(DEFAULT_GAMEPAD_BINDINGS.b1).toEqual([
      { kind: "gamepadButton", index: 0 },
    ]);
    expect(DEFAULT_GAMEPAD_BINDINGS.up).toEqual([
      { kind: "gamepadAxis", axis: 1, dir: "-" },
    ]);
    expect(DEFAULT_GAMEPAD_BINDINGS.right).toEqual([
      { kind: "gamepadAxis", axis: 0, dir: "+" },
    ]);
    expect(DEFAULT_GAMEPAD_BINDINGS.start).toEqual([
      { kind: "gamepadButton", index: 9 },
    ]);
  });
});

describe("DEFAULT_ROOM_BINDINGS", () => {
  it("assigns the keyboard to P1 and leaves P2-P4 free", () => {
    expect(DEFAULT_ROOM_BINDINGS.version).toBe(BINDINGS_VERSION);
    expect(DEFAULT_ROOM_BINDINGS.devices).toEqual([
      { kind: "keyboard" },
      null,
      null,
      null,
    ]);
    expect(DEFAULT_ROOM_BINDINGS.players).toHaveLength(4);
    expect(DEFAULT_ROOM_BINDINGS.players[0]).toBe(DEFAULT_KEYBOARD_BINDINGS);
    expect(DEFAULT_ROOM_BINDINGS.players[1]).toBe(DEFAULT_GAMEPAD_BINDINGS);
  });
});

describe("emptyFrameInputs", () => {
  it("is one zero mask per player slot", () => {
    expect(emptyFrameInputs()).toEqual([0, 0, 0, 0]);
  });
});
