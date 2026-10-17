import { attachCapture } from "./capture";
import {
  attachGamepadEvents,
  type GamepadEventTarget,
  type GamepadsProvider,
} from "./gamepad";
import type { KeyboardTarget } from "./keyboard";
import { createRemapUi, type RemapUi } from "./remap-ui";
import {
  DEFAULT_INPUT_CONFIG,
  EMPTY_LOCAL_INPUT_CONFIG,
  type InputConfig,
} from "./bindings";
import { loadLocalConfig, type StorageLike } from "./remap";

/**
 * Per-session input wiring (T12): the peer's persisted local overrides, the
 * connected gamepads, and their hot-plug events, combined into one effective
 * `InputConfig` the play controller samples every frame. Kept out of the view so
 * device assignment survives route changes.
 *
 * Assignment policy: a newly connected pad takes **P1** while P1 is still on the
 * default keyboard (so plugging a 2.4G/Bluetooth stick "just works" as player
 * one), otherwise it fills the lowest free slot (P2, P3, P4). The Controls panel
 * can override any of this, and it is persisted per browser.
 */

export interface InputSetupDeps {
  /** Per-browser storage for local overrides (localStorage). */
  storage?: StorageLike;
  /** Source of connected pads (navigator). */
  gamepads?: GamepadsProvider;
  /** Hot-plug event target (window). */
  events?: GamepadEventTarget;
  /** Key source for rebinding capture (window). */
  keyboard?: KeyboardTarget;
  hostDefault?: InputConfig;
  onChange?: (config: InputConfig) => void;
}

export interface InputSetup {
  ui: RemapUi;
  config(): InputConfig;
  /** Subscribe to hot-plug events and seed already-connected pads. */
  attach(): () => void;
}

function connectedPads(gamepads?: GamepadsProvider): number[] {
  if (!gamepads) return [];
  const out: number[] = [];
  for (const pad of gamepads.getGamepads()) {
    if (pad && pad.connected) out.push(pad.index);
  }
  return out;
}

export function createInputSetup(deps: InputSetupDeps = {}): InputSetup {
  const local = deps.storage
    ? loadLocalConfig(deps.storage)
    : EMPTY_LOCAL_INPUT_CONFIG;
  const ui = createRemapUi(deps.hostDefault ?? DEFAULT_INPUT_CONFIG, local, {
    ...(deps.storage ? { storage: deps.storage } : {}),
    ...(deps.onChange ? { onChange: deps.onChange } : {}),
  });

  // Prefer P1 for a new pad while P1 is not yet a gamepad (keyboard or empty).
  const preferredSlot = (): number | undefined =>
    ui.config().devices[0]?.kind === "gamepad" ? undefined : 0;

  // Safety net: a browser with exactly one pad is a single local player, so that
  // pad must be the one the local slot-0 controls use (netplay sends slot 0).
  // Without this, a pad left on P2 (persisted, or moved by a disconnect/reconnect)
  // silently does nothing for that player.
  const ensureSinglePadOnP1 = (): void => {
    const connected = connectedPads(deps.gamepads);
    if (connected.length !== 1) return;
    const index = connected[0];
    if (index === undefined) return;
    const first = ui.config().devices[0];
    if (first?.kind === "gamepad" && first.index === index) return;
    ui.setDevice(0, { kind: "gamepad", index });
  };

  return {
    ui,
    config: () => ui.config(),
    attach: () => {
      for (const index of connectedPads(deps.gamepads)) {
        ui.connectGamepad(index, preferredSlot());
      }
      ensureSinglePadOnP1();
      const detachCapture = attachCapture({
        ui,
        ...(deps.keyboard ? { keyboard: deps.keyboard } : {}),
        ...(deps.gamepads ? { gamepads: deps.gamepads } : {}),
      });
      const detachPads = deps.events
        ? attachGamepadEvents(deps.events, {
            onConnect: (index) => {
              ui.connectGamepad(index, preferredSlot());
              ensureSinglePadOnP1();
            },
            onDisconnect: (index) => {
              ui.disconnectGamepad(index);
              ensureSinglePadOnP1();
            },
          })
        : () => {};
      return () => {
        detachCapture();
        detachPads();
      };
    },
  };
}
