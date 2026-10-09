import { BUTTON_BITS, type Button } from "@wma/protocol";
import type { PlayerBindings } from "./bindings";

/**
 * Keyboard input device (T12). One shared KeyboardEvent source drives a
 * KeyState; the mask is recomputed from the bindings each frame so neither
 * key-repeat nor event ordering can leak into emulation.
 */

export interface KeyState {
  press(code: string): void;
  release(code: string): void;
  pressed(): ReadonlySet<string>;
  clear(): void;
}

export function createKeyState(): KeyState {
  const down = new Set<string>();
  return {
    press: (code) => {
      down.add(code);
    },
    release: (code) => {
      down.delete(code);
    },
    pressed: () => down,
    clear: () => down.clear(),
  };
}

/** OR the bits of every bound key currently held. */
export function playerMaskFromKeys(
  bindings: PlayerBindings,
  pressed: ReadonlySet<string>,
): number {
  let mask = 0;
  for (const button of Object.keys(BUTTON_BITS) as Button[]) {
    for (const binding of bindings[button]) {
      if (binding.kind === "key" && pressed.has(binding.code)) {
        mask |= BUTTON_BITS[button];
        break;
      }
    }
  }
  return mask;
}

export interface KeyboardTarget {
  addEventListener(
    type: "keydown" | "keyup",
    listener: (event: KeyboardEvent) => void,
  ): void;
  removeEventListener(
    type: "keydown" | "keyup",
    listener: (event: KeyboardEvent) => void,
  ): void;
}

export interface AttachKeyboardOptions {
  /** Codes whose browser default (scrolling, etc.) must be suppressed. */
  preventDefaultFor?: ReadonlySet<string>;
}

/** Wire DOM key events into a KeyState; returns a detach function. */
export function attachKeyboard(
  target: KeyboardTarget,
  state: KeyState,
  options: AttachKeyboardOptions = {},
): () => void {
  const onDown = (event: KeyboardEvent): void => {
    state.press(event.code);
    if (options.preventDefaultFor?.has(event.code)) {
      event.preventDefault();
    }
  };
  const onUp = (event: KeyboardEvent): void => {
    state.release(event.code);
  };
  target.addEventListener("keydown", onDown);
  target.addEventListener("keyup", onUp);
  return () => {
    target.removeEventListener("keydown", onDown);
    target.removeEventListener("keyup", onUp);
  };
}
