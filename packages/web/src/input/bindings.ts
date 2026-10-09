import { BUTTON_BITS, PLAYER_SLOTS, type Button } from "@wma/protocol";
import type { FrameInputs } from "../core/types";

/**
 * Local input model (T12). This is *host-local configuration* for one browser:
 * it decides which physical control feeds which mask bit. It is never sent over
 * the wire — only the resulting per-frame mask is — so remapping can never cause
 * a desync. See docs/contracts/input-packet.md.
 *
 * A room/host announces an `InputConfig` as a *default*; a joining peer layers
 * its own `LocalInputConfig` (only the slots it customized) over it. Each person
 * therefore keeps their own mapping and never inherits someone else's.
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

/** A complete, resolved input configuration (devices + per-slot bindings). */
export interface InputConfig {
  version: number;
  devices: DeviceSlots;
  players: readonly PlayerBindings[];
}

/**
 * The subset of a config a single peer has customized. `undefined` means
 * "inherit the host/default value for this slot"; a value overrides it.
 */
export interface LocalInputConfig {
  version: number;
  devices: readonly (InputDevice | null | undefined)[];
  players: readonly (PlayerBindings | undefined)[];
}

export const BINDINGS_VERSION = 1;

/** All buttons in contract order; the single iteration source for masks. */
export const ALL_BUTTONS = Object.keys(BUTTON_BITS) as Button[];

/** Stable identity key for a binding (used for dedupe and conflict checks). */
export function bindingKey(binding: Binding): string {
  if (binding.kind === "key") return `key:${binding.code}`;
  if (binding.kind === "gamepadButton") return `padButton:${binding.index}`;
  return `padAxis:${binding.axis}:${binding.dir}`;
}

/** A binding set with the given buttons bound and every other button empty. */
export function playerBindings(
  bindings: Partial<Record<Button, Binding[]>>,
): PlayerBindings {
  const out = {} as PlayerBindings;
  for (const button of ALL_BUTTONS) {
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

/** Built-in default: P1 on the keyboard; gamepads fill P2-P4 as they connect. */
export const DEFAULT_INPUT_CONFIG: InputConfig = {
  version: BINDINGS_VERSION,
  devices: [{ kind: "keyboard" }, null, null, null],
  players: [
    DEFAULT_KEYBOARD_BINDINGS,
    DEFAULT_GAMEPAD_BINDINGS,
    DEFAULT_GAMEPAD_BINDINGS,
    DEFAULT_GAMEPAD_BINDINGS,
  ],
};

/** No local overrides: follow the host/default config for every slot. */
export const EMPTY_LOCAL_INPUT_CONFIG: LocalInputConfig = {
  version: BINDINGS_VERSION,
  devices: Array.from({ length: PLAYER_SLOTS }, () => undefined),
  players: Array.from({ length: PLAYER_SLOTS }, () => undefined),
};

/** Layer a peer's local overrides over the host/default config. */
export function resolveInputConfig(
  base: InputConfig,
  local: LocalInputConfig,
): InputConfig {
  return {
    version: base.version,
    devices: base.devices.map((device, slot) => {
      const override = local.devices[slot];
      return override === undefined ? device : override;
    }),
    players: base.players.map(
      (player, slot) => local.players[slot] ?? player,
    ),
  };
}

/** Four zero masks, one per player slot. */
export function emptyFrameInputs(): FrameInputs {
  return [0, 0, 0, 0];
}
