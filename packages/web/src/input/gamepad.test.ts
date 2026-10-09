import { describe, expect, it, vi } from "vitest";
import { BUTTON_BITS } from "@wma/protocol";
import { DEFAULT_GAMEPAD_BINDINGS, playerBindings } from "./bindings";
import {
  attachGamepadEvents,
  createAxisState,
  playerMaskFromPad,
  readGamepads,
  type GamepadEventTarget,
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

  it("settles every axis binding even when a button is already active", () => {
    const state = createAxisState();
    const opts = { deadzone: 0.5, hysteresis: 0.1 };
    const bindings = playerBindings({
      b1: [
        { kind: "gamepadButton", index: 0 },
        { kind: "gamepadAxis", axis: 1, dir: "-" },
      ],
    });
    const held = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    held[0] = { pressed: true, value: 1 };
    // Frame 1: button fires and the axis is past the deadzone.
    playerMaskFromPad(bindings, pad({ buttons: held, axes: [0, -0.6, 0, 0] }), state, opts);
    // Frame 2: button released, axis inside the hysteresis band -> must stay on.
    const released = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
    expect(
      playerMaskFromPad(
        bindings,
        pad({ buttons: released, axes: [0, -0.45, 0, 0] }),
        state,
        opts,
      ),
    ).toBe(BUTTON_BITS.b1);
  });
});

describe("readGamepads", () => {
  it("returns whatever the provider reports", () => {
    const gamepads = [pad({ index: 0 }), null, pad({ index: 2 })];
    const provider: GamepadsProvider = { getGamepads: () => gamepads };
    expect(readGamepads(provider)).toBe(gamepads);
  });
});

function fakeEventTarget(): GamepadEventTarget & {
  emit: (type: "gamepadconnected" | "gamepaddisconnected", index: number) => void;
} {
  const listeners = new Map<string, Set<(event: { gamepad: GamepadLike }) => void>>();
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, index) {
      for (const listener of listeners.get(type) ?? []) {
        listener({ gamepad: pad({ index }) });
      }
    },
  };
}

describe("attachGamepadEvents", () => {
  it("reports connect and disconnect with the gamepad index", () => {
    const target = fakeEventTarget();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    attachGamepadEvents(target, { onConnect, onDisconnect });
    target.emit("gamepadconnected", 2);
    target.emit("gamepaddisconnected", 2);
    expect(onConnect).toHaveBeenCalledWith(2);
    expect(onDisconnect).toHaveBeenCalledWith(2);
  });

  it("stops reporting after detach", () => {
    const target = fakeEventTarget();
    const onConnect = vi.fn();
    const detach = attachGamepadEvents(target, { onConnect });
    detach();
    target.emit("gamepadconnected", 0);
    expect(onConnect).not.toHaveBeenCalled();
  });
});
