import { describe, expect, it } from "vitest";
import { BUTTON_BITS } from "@wma/protocol";
import { DEFAULT_GAMEPAD_BINDINGS, playerBindings } from "./bindings";
import {
  createAxisState,
  playerMaskFromPad,
  readGamepads,
  type GamepadLike,
  type GamepadsProvider,
} from "./gamepad";

function pad(overrides: Partial<GamepadLike> = {}): GamepadLike {
  return {
    index: 0,
    mapping: "standard",
    connected: true,
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
    ...overrides,
  };
}

function withButton(index: number): GamepadLike {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  buttons[index] = { pressed: true, value: 1 };
  return pad({ buttons });
}

describe("playerMaskFromPad buttons", () => {
  it("sets the bit for a pressed bound button", () => {
    expect(
      playerMaskFromPad(DEFAULT_GAMEPAD_BINDINGS, withButton(0), createAxisState()),
    ).toBe(BUTTON_BITS.b1);
  });

  it("ORs simultaneous buttons", () => {
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    buttons[0] = { pressed: true, value: 1 };
    buttons[1] = { pressed: true, value: 1 };
    expect(
      playerMaskFromPad(DEFAULT_GAMEPAD_BINDINGS, pad({ buttons }), createAxisState()),
    ).toBe(BUTTON_BITS.b1 | BUTTON_BITS.b2);
  });

  it("uses indices even on a non-standard mapping pad", () => {
    expect(
      playerMaskFromPad(
        DEFAULT_GAMEPAD_BINDINGS,
        withButton(0),
        createAxisState(),
      ),
    ).toBe(BUTTON_BITS.b1);
  });

  it("ignores an unbound button index", () => {
    expect(
      playerMaskFromPad(DEFAULT_GAMEPAD_BINDINGS, withButton(15), createAxisState()),
    ).toBe(0);
  });

  it("ignores a binding whose index is out of range", () => {
    const bindings = playerBindings({ b1: [{ kind: "gamepadButton", index: 99 }] });
    expect(playerMaskFromPad(bindings, pad(), createAxisState())).toBe(0);
  });
});

describe("playerMaskFromPad axes", () => {
  it("turns a past-deadzone axis into a direction bit", () => {
    expect(
      playerMaskFromPad(
        DEFAULT_GAMEPAD_BINDINGS,
        pad({ axes: [0, -0.9, 0, 0] }),
        createAxisState(),
      ),
    ).toBe(BUTTON_BITS.up);
  });

  it("ignores an axis inside the deadzone", () => {
    expect(
      playerMaskFromPad(
        DEFAULT_GAMEPAD_BINDINGS,
        pad({ axes: [0, -0.2, 0, 0] }),
        createAxisState(),
      ),
    ).toBe(0);
  });

  it("maps both horizontal directions", () => {
    expect(
      playerMaskFromPad(
        DEFAULT_GAMEPAD_BINDINGS,
        pad({ axes: [0.8, 0, 0, 0] }),
        createAxisState(),
      ),
    ).toBe(BUTTON_BITS.right);
    expect(
      playerMaskFromPad(
        DEFAULT_GAMEPAD_BINDINGS,
        pad({ axes: [-0.8, 0, 0, 0] }),
        createAxisState(),
      ),
    ).toBe(BUTTON_BITS.left);
  });

  it("applies hysteresis so a direction does not flicker near the deadzone", () => {
    const state = createAxisState();
    const opts = { deadzone: 0.5, hysteresis: 0.1 };
    const mask = (value: number) =>
      playerMaskFromPad(
        DEFAULT_GAMEPAD_BINDINGS,
        pad({ axes: [0, value, 0, 0] }),
        state,
        opts,
      );
    expect(mask(-0.6)).toBe(BUTTON_BITS.up);
    expect(mask(-0.45)).toBe(BUTTON_BITS.up);
    expect(mask(-0.35)).toBe(0);
  });

  it("keeps each player's axis state independent", () => {
    const p1 = createAxisState();
    const p2 = createAxisState();
    const opts = { deadzone: 0.5, hysteresis: 0.1 };
    playerMaskFromPad(DEFAULT_GAMEPAD_BINDINGS, pad({ axes: [0, -0.6, 0, 0] }), p1, opts);
    expect(
      playerMaskFromPad(DEFAULT_GAMEPAD_BINDINGS, pad({ axes: [0, -0.45, 0, 0] }), p2, opts),
    ).toBe(0);
  });
});

describe("readGamepads", () => {
  it("returns whatever the provider reports", () => {
    const gamepads = [pad({ index: 0 }), null, pad({ index: 2 })];
    const provider: GamepadsProvider = { getGamepads: () => gamepads };
    expect(readGamepads(provider)).toBe(gamepads);
  });
});
