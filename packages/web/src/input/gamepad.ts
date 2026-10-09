import { BUTTON_BITS } from "@wma/protocol";
import { ALL_BUTTONS, bindingKey, type Binding, type PlayerBindings } from "./bindings";

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
  // Settle every axis binding unconditionally first, so hysteresis state is
  // never skipped by an earlier satisfied binding (which would make the mask
  // depend on binding-array order).
  const axisActive = new Map<string, boolean>();
  for (const button of ALL_BUTTONS) {
    for (const binding of bindings[button]) {
      if (binding.kind === "gamepadAxis") {
        const key = axisKey(binding.axis, binding.dir);
        const value = gamepad.axes[binding.axis] ?? 0;
        axisActive.set(
          bindingKey(binding),
          axisDirection(value, binding.dir, key, axisState, options),
        );
      }
    }
  }

  let mask = 0;
  for (const button of ALL_BUTTONS) {
    for (const binding of bindings[button]) {
      if (isBindingActive(binding, gamepad, axisActive)) {
        mask |= BUTTON_BITS[button];
      }
    }
  }
  return mask;
}

function isBindingActive(
  binding: Binding,
  gamepad: GamepadLike,
  axisActive: ReadonlyMap<string, boolean>,
): boolean {
  if (binding.kind === "gamepadButton") {
    return gamepad.buttons[binding.index]?.pressed ?? false;
  }
  if (binding.kind === "gamepadAxis") {
    return axisActive.get(bindingKey(binding)) ?? false;
  }
  return false;
}

/** Read the current gamepad snapshots from a navigator-like provider. */
export function readGamepads(
  provider: GamepadsProvider,
): readonly (GamepadLike | null)[] {
  return provider.getGamepads();
}

export interface GamepadEventLike {
  gamepad: GamepadLike;
}

export interface GamepadEventTarget {
  addEventListener(
    type: "gamepadconnected" | "gamepaddisconnected",
    listener: (event: GamepadEventLike) => void,
  ): void;
  removeEventListener(
    type: "gamepadconnected" | "gamepaddisconnected",
    listener: (event: GamepadEventLike) => void,
  ): void;
}

export interface GamepadEventHandlers {
  onConnect?(index: number): void;
  onDisconnect?(index: number): void;
}

/**
 * Bridge browser gamepad hot-plug events to index callbacks. Gamepads are only
 * visible after a user gesture in most browsers; callers should prompt for one.
 */
export function attachGamepadEvents(
  target: GamepadEventTarget,
  handlers: GamepadEventHandlers,
): () => void {
  const onConnect = (event: GamepadEventLike): void => {
    handlers.onConnect?.(event.gamepad.index);
  };
  const onDisconnect = (event: GamepadEventLike): void => {
    handlers.onDisconnect?.(event.gamepad.index);
  };
  target.addEventListener("gamepadconnected", onConnect);
  target.addEventListener("gamepaddisconnected", onDisconnect);
  return () => {
    target.removeEventListener("gamepadconnected", onConnect);
    target.removeEventListener("gamepaddisconnected", onDisconnect);
  };
}
