import { describe, expect, it } from "vitest";
import { BUTTON_BITS } from "@wma/protocol";
import { DEFAULT_INPUT_CONFIG, type InputConfig } from "./bindings";
import { createKeyState } from "./keyboard";
import { createSampleState, sampleFrameInputs } from "./sample";
import type { GamepadLike } from "./gamepad";

const empty = [null, null, null, null] as const;

function pad(index: number, overrides: Partial<GamepadLike> = {}): GamepadLike {
  return {
    index,
    mapping: "standard",
    connected: true,
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
    ...overrides,
  };
}

function withButton(index: number): GamepadLike {
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  buttons[0] = { pressed: true, value: 1 };
  return pad(index, { buttons });
}

describe("sampleFrameInputs", () => {
  it("reads the keyboard into its assigned slot only", () => {
    const keys = createKeyState();
    keys.press("KeyZ");
    const frame = sampleFrameInputs(
      DEFAULT_INPUT_CONFIG,
      keys,
      [],
      createSampleState(),
    );
    expect(frame).toEqual([BUTTON_BITS.b1, 0, 0, 0]);
  });

  it("reads a gamepad into its assigned slot", () => {
    const room: InputConfig = {
      ...DEFAULT_INPUT_CONFIG,
      devices: [{ kind: "keyboard" }, { kind: "gamepad", index: 1 }, null, null],
    };
    const frame = sampleFrameInputs(
      room,
      createKeyState(),
      [null, withButton(1)],
      createSampleState(),
    );
    expect(frame).toEqual([0, BUTTON_BITS.b1, 0, 0]);
  });

  it("keeps two devices independent", () => {
    const room: InputConfig = {
      ...DEFAULT_INPUT_CONFIG,
      devices: [
        { kind: "keyboard" },
        { kind: "gamepad", index: 0 },
        null,
        null,
      ],
    };
    const keys = createKeyState();
    keys.press("ArrowUp");
    const frame = sampleFrameInputs(
      room,
      keys,
      [withButton(0)],
      createSampleState(),
    );
    expect(frame).toEqual([BUTTON_BITS.up, BUTTON_BITS.b1, 0, 0]);
  });

  it("leaves unassigned slots at zero", () => {
    const room: InputConfig = { ...DEFAULT_INPUT_CONFIG, devices: empty };
    expect(
      sampleFrameInputs(room, createKeyState(), [], createSampleState()),
    ).toEqual([0, 0, 0, 0]);
  });

  it("reports zero for an assigned gamepad that is not connected", () => {
    const room: InputConfig = {
      ...DEFAULT_INPUT_CONFIG,
      devices: [{ kind: "keyboard" }, { kind: "gamepad", index: 2 }, null, null],
    };
    expect(
      sampleFrameInputs(room, createKeyState(), [null, null], createSampleState()),
    ).toEqual([0, 0, 0, 0]);
  });

  it("carries axis hysteresis across frames for an assigned pad", () => {
    const room: InputConfig = {
      ...DEFAULT_INPUT_CONFIG,
      devices: [{ kind: "keyboard" }, { kind: "gamepad", index: 0 }, null, null],
    };
    const state = createSampleState();
    const axes = (value: number) => [0, value, 0, 0];
    const first = sampleFrameInputs(
      room,
      createKeyState(),
      [pad(0, { axes: axes(-0.6) })],
      state,
    );
    const second = sampleFrameInputs(
      room,
      createKeyState(),
      [pad(0, { axes: axes(-0.45) })],
      state,
    );
    expect(first[1]).toBe(BUTTON_BITS.up);
    expect(second[1]).toBe(BUTTON_BITS.up);
  });

  it("resets axis state when a slot's gamepad is replaced", () => {
    const base: InputConfig = {
      ...DEFAULT_INPUT_CONFIG,
      devices: [{ kind: "keyboard" }, { kind: "gamepad", index: 0 }, null, null],
    };
    const state = createSampleState();
    const first = sampleFrameInputs(
      base,
      createKeyState(),
      [pad(0, { axes: [0, -0.6, 0, 0] })],
      state,
    );
    expect(first[1]).toBe(BUTTON_BITS.up);

    const swapped: InputConfig = {
      ...base,
      devices: [{ kind: "keyboard" }, { kind: "gamepad", index: 1 }, null, null],
    };
    const second = sampleFrameInputs(
      swapped,
      createKeyState(),
      [null, pad(1, { axes: [0, -0.45, 0, 0] })],
      state,
    );
    expect(second[1]).toBe(0);
  });
});
