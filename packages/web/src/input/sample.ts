import { PLAYER_SLOTS } from "@wma/protocol";
import type { FrameInputs } from "../core/types";
import type { RoomBindings } from "./bindings";
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
 * device are zero. Axis hysteresis state is kept per slot across frames.
 */

export interface SampleState {
  axes: AxisState[];
}

export function createSampleState(): SampleState {
  return { axes: Array.from({ length: PLAYER_SLOTS }, createAxisState) };
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
  room: RoomBindings,
  keys: KeyState,
  gamepads: readonly (GamepadLike | null)[],
  state: SampleState,
  options?: AxisOptions,
): FrameInputs {
  const pressed = keys.pressed();
  const masks = Array.from({ length: PLAYER_SLOTS }, (_, slot) => {
    const device = room.devices[slot];
    const bindings = room.players[slot];
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
  return [masks[0] ?? 0, masks[1] ?? 0, masks[2] ?? 0, masks[3] ?? 0];
}
