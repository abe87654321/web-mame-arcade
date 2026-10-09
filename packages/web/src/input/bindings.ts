import { BUTTON_BITS, type Button } from "@wma/protocol";
import type { FrameInputs } from "../core/types";

/**
 * Local input model (T12). A physical device is assigned to one player slot;
 * that player's bindings translate the device's keys/buttons/axes into the
 * u16 mask defined by docs/contracts/input-packet.md. Bindings are host-local
 * configuration — only the resulting mask travels over the wire, so remapping
 * never risks a desync.
 */

export type Binding =
  | { kind: "key"; code: string }
  | { kind: "gamepadButton"; index: number }
  | { kind: "gamepadAxis"; axis: number; dir: "-" | "+" };

export type InputDevice =
  | { kind: "keyboard" }
  | { kind: "gamepad"; index: number };

/** One device (or null) per player slot, indexed 0..PLAYER_SLOTS-1. */
export type DeviceSlots = readonly (InputDevice | null)[];

/** Every button maps to zero or more physical bindings. */
export type PlayerBindings = Record<Button, Binding[]>;

export interface RoomBindings {
  version: number;
  devices: DeviceSlots;
  players: readonly PlayerBindings[];
}

export const BINDINGS_VERSION = 1;

/** A binding set with the given buttons bound and every other button empty. */
export function playerBindings(
  bindings: Partial<Record<Button, Binding[]>>,
): PlayerBindings {
  const out = {} as PlayerBindings;
  for (const button of Object.keys(BUTTON_BITS) as Button[]) {
    out[button] = bindings[button] ? [...bindings[button]] : [];
  }
  return out;
}

/** Standard-mapping gamepad defaults (Xbox/PS layout). */
export const DEFAULT_GAMEPAD_BINDINGS: PlayerBindings = playerBindings({
  up: [{ kind: "gamepadAxis", axis: 1, dir: "-" }],
  down: [{ kind: "gamepadAxis", axis: 1, dir: "+" }],
  left: [{ kind: "gamepadAxis", axis: 0, dir: "-" }],
  right: [{ kind: "gamepadAxis", axis: 0, dir: "+" }],
  b1: [{ kind: "gamepadButton", index: 0 }],
  b2: [{ kind: "gamepadButton", index: 1 }],
  b3: [{ kind: "gamepadButton", index: 2 }],
  b4: [{ kind: "gamepadButton", index: 3 }],
  b5: [{ kind: "gamepadButton", index: 4 }],
  b6: [{ kind: "gamepadButton", index: 5 }],
  start: [{ kind: "gamepadButton", index: 9 }],
  coin: [{ kind: "gamepadButton", index: 8 }],
});

/** Keyboard defaults; start/coin follow MAME's 1/5 keys. */
export const DEFAULT_KEYBOARD_BINDINGS: PlayerBindings = playerBindings({
  up: [{ kind: "key", code: "ArrowUp" }],
  down: [{ kind: "key", code: "ArrowDown" }],
  left: [{ kind: "key", code: "ArrowLeft" }],
  right: [{ kind: "key", code: "ArrowRight" }],
  b1: [{ kind: "key", code: "KeyZ" }],
  b2: [{ kind: "key", code: "KeyX" }],
  b3: [{ kind: "key", code: "KeyC" }],
  b4: [{ kind: "key", code: "KeyV" }],
  b5: [{ kind: "key", code: "KeyA" }],
  b6: [{ kind: "key", code: "KeyS" }],
  start: [{ kind: "key", code: "Digit1" }],
  coin: [{ kind: "key", code: "Digit5" }],
});

/** P1 starts on the keyboard; gamepads fill P2-P4 as they connect. */
export const DEFAULT_ROOM_BINDINGS: RoomBindings = {
  version: BINDINGS_VERSION,
  devices: [{ kind: "keyboard" }, null, null, null],
  players: [
    DEFAULT_KEYBOARD_BINDINGS,
    DEFAULT_GAMEPAD_BINDINGS,
    DEFAULT_GAMEPAD_BINDINGS,
    DEFAULT_GAMEPAD_BINDINGS,
  ],
};

/** Four zero masks, one per player slot. */
export function emptyFrameInputs(): FrameInputs {
  return [0, 0, 0, 0];
}
