import type { GamepadsProvider } from "./gamepad";
import type { KeyboardTarget } from "./keyboard";
import type { RemapUi } from "./remap-ui";
import type { Binding } from "./bindings";

/**
 * Rebinding capture (T12): while the Controls panel is waiting for a control
 * (`ui.capture()` is set), feed the next key press or gamepad button/axis into
 * `ui.captureBinding`. Keyboard capture is event-driven; gamepads are polled on
 * `requestAnimationFrame` (there are no per-button DOM events), so an
 * non-standard pad can be bound by pressing its actual controls.
 */

const AXIS_CAPTURE_THRESHOLD = 0.6;

export interface CaptureDeps {
  ui: RemapUi;
  keyboard?: KeyboardTarget;
  gamepads?: GamepadsProvider;
}

/** First pressed button index on a pad, or -1. */
function pressedButton(pad: { buttons: readonly { pressed: boolean }[] }): number {
  for (let i = 0; i < pad.buttons.length; i++) {
    if (pad.buttons[i]?.pressed) return i;
  }
  return -1;
}

/** A direction binding for the first axis past the capture threshold, or null. */
function movedAxis(pad: {
  axes: readonly number[];
}): Binding | null {
  for (let i = 0; i < pad.axes.length; i++) {
    const value = pad.axes[i] ?? 0;
    if (Math.abs(value) >= AXIS_CAPTURE_THRESHOLD) {
      return { kind: "gamepadAxis", axis: i, dir: value > 0 ? "+" : "-" };
    }
  }
  return null;
}

export function attachCapture(deps: CaptureDeps): () => void {
  const { ui } = deps;

  const onKey = (event: KeyboardEvent): void => {
    if (!ui.capture()) return;
    if (ui.captureBinding({ kind: "key", code: event.code })) {
      event.preventDefault();
    }
  };
  deps.keyboard?.addEventListener("keydown", onKey);

  // Poll pads only where rAF exists (browser); tests drive captureBinding
  // directly. Stop when a binding is captured so one press binds one button.
  let handle = 0;
  const canPoll =
    deps.gamepads !== undefined && typeof requestAnimationFrame === "function";
  const poll = (): void => {
    if (ui.capture()) {
      for (const pad of deps.gamepads?.getGamepads() ?? []) {
        if (!pad) continue;
        const button = pressedButton(pad);
        const binding: Binding | null =
          button >= 0
            ? { kind: "gamepadButton", index: button }
            : movedAxis(pad);
        if (binding && ui.captureBinding(binding)) break;
      }
    }
    handle = requestAnimationFrame(poll);
  };
  if (canPoll) handle = requestAnimationFrame(poll);

  return () => {
    deps.keyboard?.removeEventListener("keydown", onKey);
    if (handle) cancelAnimationFrame(handle);
  };
}
