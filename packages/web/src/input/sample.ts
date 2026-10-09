import { PLAYER_SLOTS } from "@wma/protocol";
import type { FrameInputs } from "../core/types";
import { toWireMask } from "./buttons";
import type { InputDevice, InputConfig } from "./bindings";
import { sameDevice } from "./devices";
import {
  createAxisState,
  playerMaskFromPad,
  type AxisOptions,
  type AxisState,
  type GamepadLike,
} from "./gamepad";
import { playerMaskFromKeys, type KeyState } from "./keyboard";

/**
 * Assemble one FrameInputs tuple per animation frame from the local devices
 * (T12). Each slot's assigned device contributes its own mask; slots with no
 * device are zero. Axis hysteresis state is kept per slot and reset whenever a
 * slot's device changes, so a freshly assigned pad cannot inherit stale
 * directions from the device it replaced.
 */

export interface SampleState {
  axes: AxisState[];
  devices: (InputDevice | null)[];
}

export function createSampleState(): SampleState {
  return {
    axes: Array.from({ length: PLAYER_SLOTS }, createAxisState),
    devices: Array.from({ length: PLAYER_SLOTS }, () => null),
  };
}

function sameSlotDevice(
  a: InputDevice | null,
  b: InputDevice | null,
): boolean {
  if (a === null || b === null) return a === b;
  return sameDevice(a, b);
}

function findGamepad(
  gamepads: readonly (GamepadLike | null)[],
  index: number,
): GamepadLike | null {
  for (const gamepad of gamepads) {
    if (gamepad && gamepad.index === index) return gamepad;
  }
  return null;
}

export function sampleFrameInputs(
  room: InputConfig,
  keys: KeyState,
  gamepads: readonly (GamepadLike | null)[],
  state: SampleState,
  options?: AxisOptions,
): FrameInputs {
  const pressed = keys.pressed();
  const masks = Array.from({ length: PLAYER_SLOTS }, (_, slot) => {
    const device = room.devices[slot] ?? null;
    const bindings = room.players[slot];
    if (!sameSlotDevice(state.devices[slot] ?? null, device)) {
      state.devices[slot] = device;
      state.axes[slot] = createAxisState();
    }
    if (!device || !bindings) return 0;
    if (device.kind === "keyboard") {
      return playerMaskFromKeys(bindings, pressed);
    }
    const gamepad = findGamepad(gamepads, device.index);
    if (!gamepad || !gamepad.connected) return 0;
    const axisState = state.axes[slot] ?? createAxisState();
    state.axes[slot] = axisState;
    return playerMaskFromPad(bindings, gamepad, axisState, options);
  });
  return [
    toWireMask(masks[0] ?? 0),
    toWireMask(masks[1] ?? 0),
    toWireMask(masks[2] ?? 0),
    toWireMask(masks[3] ?? 0),
  ];
}
