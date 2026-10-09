import { BUTTON_BITS, type Button } from "@wma/protocol";
import type { PlayerBindings } from "./bindings";

/**
 * Gamepad input device (T12). Buttons bind by index so non-standard pads
 * (mapping === "") work too; analog axes are quantised to the four digital
 * direction bits with a deadzone plus hysteresis. True analog values need a
 * contract extension (bits 12-15 are reserved) and are not sent yet.
 */

export interface GamepadButtonLike {
  pressed: boolean;
  value: number;
}

export interface GamepadLike {
  index: number;
  mapping: string;
  connected: boolean;
  buttons: readonly GamepadButtonLike[];
  axes: readonly number[];
}

export interface GamepadsProvider {
  getGamepads(): readonly (GamepadLike | null)[];
}

export const DEFAULT_DEADZONE = 0.5;
export const DEFAULT_HYSTERESIS = 0.1;

export interface AxisOptions {
  deadzone: number;
  hysteresis: number;
}

/**
 * Per-player axis memory for hysteresis. Recomputed every frame from the
 * current value, so it is loop state, not accumulated history.
 */
export interface AxisState {
  pressed: Map<string, boolean>;
}

export function createAxisState(): AxisState {
  return { pressed: new Map() };
}

function axisKey(axis: number, dir: "-" | "+"): string {
  return `${axis}:${dir}`;
}

function axisDirection(
  value: number,
  dir: "-" | "+",
  key: string,
  state: AxisState,
  { deadzone, hysteresis }: AxisOptions,
): boolean {
  const magnitude = Math.abs(value);
  const exit = Math.max(0, deadzone - hysteresis);
  const was = state.pressed.get(key) ?? false;
  const matchesDir = dir === "+" ? value > 0 : value < 0;
  let on: boolean;
  if (matchesDir && magnitude >= deadzone) {
    on = true;
  } else if (was && matchesDir && magnitude > exit) {
    on = true;
  } else {
    on = false;
  }
  state.pressed.set(key, on);
  return on;
}

/** OR the bits of every bound gamepad button/axis active on this frame. */
export function playerMaskFromPad(
  bindings: PlayerBindings,
  gamepad: GamepadLike,
  axisState: AxisState,
  options: AxisOptions = {
    deadzone: DEFAULT_DEADZONE,
    hysteresis: DEFAULT_HYSTERESIS,
  },
): number {
  let mask = 0;
  for (const button of Object.keys(BUTTON_BITS) as Button[]) {
    for (const binding of bindings[button]) {
      if (binding.kind === "gamepadButton") {
        if (gamepad.buttons[binding.index]?.pressed) {
          mask |= BUTTON_BITS[button];
          break;
        }
      } else if (binding.kind === "gamepadAxis") {
        const key = axisKey(binding.axis, binding.dir);
        const value = gamepad.axes[binding.axis] ?? 0;
        if (axisDirection(value, binding.dir, key, axisState, options)) {
          mask |= BUTTON_BITS[button];
          break;
        }
      }
    }
  }
  return mask;
}

/** Read the current gamepad snapshots from a navigator-like provider. */
export function readGamepads(
  provider: GamepadsProvider,
): readonly (GamepadLike | null)[] {
  return provider.getGamepads();
}
