import { describe, expect, it } from "vitest";
import { BUTTON_BITS, PLAYER_SLOTS } from "@wma/protocol";
import {
  DEFAULT_GAMEPAD_BINDINGS,
  DEFAULT_KEYBOARD_BINDINGS,
  mergeBindings,
  playerBindings,
  type InputConfig,
} from "./bindings";
import { createKeyState } from "./keyboard";
import { createSampleState, sampleFrameInputs } from "./sample";
import type { GamepadLike } from "./gamepad";

// P1 is assigned a gamepad but keeps the keyboard bindings, so both devices
// drive slot 0 (keyboard + pad together).
const config: InputConfig = {
  version: 1,
  devices: [{ kind: "gamepad", index: 0 }, null, null, null],
  players: [
    mergeBindings(DEFAULT_KEYBOARD_BINDINGS, DEFAULT_GAMEPAD_BINDINGS),
    ...Array.from({ length: PLAYER_SLOTS - 1 }, () => playerBindings({})),
  ],
};

function pad(overrides: Partial<GamepadLike> = {}): GamepadLike {
  return {
    index: 0,
    mapping: "standard",
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    ...overrides,
  };
}

describe("sampleFrameInputs on a gamepad slot", () => {
  it("reads the gamepad's button", () => {
    const buttons = pad().buttons.map((b, i) =>
      i === 0 ? { pressed: true, value: 1 } : b,
    );
    const mask = sampleFrameInputs(config, createKeyState(), [{ ...pad(), buttons }], createSampleState());
    expect(mask[0]).toBe(BUTTON_BITS.b1);
  });

  it("also reads the keyboard when a pad is assigned", () => {
    const keys = createKeyState();
    keys.press("ArrowRight");
    const mask = sampleFrameInputs(config, keys, [], createSampleState());
    expect(mask[0]).toBe(BUTTON_BITS.right);
  });

  it("ORs keyboard and gamepad together", () => {
    const keys = createKeyState();
    keys.press("ArrowRight");
    const buttons = pad().buttons.map((b, i) =>
      i === 0 ? { pressed: true, value: 1 } : b,
    );
    const mask = sampleFrameInputs(config, keys, [{ ...pad(), buttons }], createSampleState());
    expect(mask[0]).toBe(BUTTON_BITS.right | BUTTON_BITS.b1);
  });
});
