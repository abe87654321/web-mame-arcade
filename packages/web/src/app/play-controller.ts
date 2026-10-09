import type { Core, FrameInputs } from "../core/types";
import type { GameEntry } from "../catalogue";
import {
  DEFAULT_INPUT_CONFIG,
  emptyFrameInputs,
  type Binding,
  type InputConfig,
} from "../input/bindings";
import type { GamepadsProvider } from "../input/gamepad";
import {
  attachKeyboard,
  createKeyState,
  type KeyState,
  type KeyboardTarget,
} from "../input/keyboard";
import { createSampleState, sampleFrameInputs } from "../input/sample";
import type { UiDocument, UiElement } from "../ui/view";

/**
 * Play-page controller (T13/T24). Boots the core, mounts its canvas and runs
 * one input-sampling tick per animation frame. Solo, the stock Emscripten build
 * runs MAME itself and this loop only samples the local devices. In netplay the
 * injected `lockstep` owns the frame clock: each tick hands it the sampled
 * `FrameInputs` and it calls `core.step` when every player's inputs are ready.
 * Sampling is stateless beyond axis hysteresis, and nothing here reads the
 * clock or randomness.
 */

export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/** requestAnimationFrame/cancelAnimationFrame adapter. */
export function browserScheduler(): FrameScheduler {
  return {
    request: (callback) => globalThis.requestAnimationFrame(() => callback()),
    cancel: (handle) => globalThis.cancelAnimationFrame(handle),
  };
}

export interface PlayDeps {
  core: Core;
  entry: GameEntry;
  document: UiDocument;
  scheduler: FrameScheduler;
  keyboard: KeyboardTarget;
  gamepads: GamepadsProvider;
  /** Effective input config; defaults to the built-in keyboard P1 config. */
  inputConfig?: InputConfig;
  /** Netplay lockstep loop; when present it drives `core.step` (T24). */
  lockstep?: { tick(localMask: number): void };
  /**
   * The canvas the core already rendered into (mounted before boot). When
   * absent (tests), the controller creates one.
   */
  screen?: UiElement;
  /** Status line sink (boot/errors). */
  onStatus?: (text: string) => void;
}

export interface PlayController {
  /** The canvas element to mount; MAME renders into it. */
  screen: UiElement;
  /** Latest sampled mask per player slot. */
  inputs(): FrameInputs;
  destroy(): void;
}

/** Key codes whose browser default (scrolling, shortcuts) must be suppressed. */
function boundKeyCodes(config: InputConfig): Set<string> {
  const codes = new Set<string>();
  for (const player of config.players) {
    for (const bindings of Object.values(player)) {
      for (const binding of bindings as Binding[]) {
        if (binding.kind === "key") codes.add(binding.code);
      }
    }
  }
  return codes;
}

export function createPlayController(deps: PlayDeps): PlayController {
  const config = deps.inputConfig ?? DEFAULT_INPUT_CONFIG;
  const screen = deps.screen ?? deps.document.createElement("canvas");
  screen.className = "screen";

  const keys: KeyState = createKeyState();
  const detachKeys = attachKeyboard(deps.keyboard, keys, {
    preventDefaultFor: boundKeyCodes(config),
  });
  const sampleState = createSampleState();

  let current: FrameInputs = emptyFrameInputs();
  let handle: number | null = null;
  let running = true;

  const tick = (): void => {
    if (!running) return;
    current = sampleFrameInputs(config, keys, deps.gamepads.getGamepads(), sampleState);
    // Netplay: this browser's own controls come from the local slot-0 config;
    // the lockstep attributes them to our room slot. Solo leaves `current` for
    // the local multi-slot view.
    deps.lockstep?.tick(current[0] ?? 0);
    handle = deps.scheduler.request(tick);
  };

  void Promise.resolve(deps.core.load()).catch((error: unknown) => {
    deps.onStatus?.(`core error: ${String(error)}`);
  });
  deps.onStatus?.(`running ${deps.entry.title}`);
  handle = deps.scheduler.request(tick);

  return {
    screen,
    inputs: () => current,
    destroy: () => {
      running = false;
      if (handle !== null) deps.scheduler.cancel(handle);
      detachKeys();
      // The controller owns the booted core; stop MAME/Emscripten with it so a
      // route change cannot leave a background emulator running.
      deps.core.destroy();
    },
  };
}
