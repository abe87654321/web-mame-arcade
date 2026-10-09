import { PLAYER_SLOTS, type Button } from "@wma/protocol";
import {
  ALL_BUTTONS,
  BINDINGS_VERSION,
  EMPTY_LOCAL_INPUT_CONFIG,
  type Binding,
  type InputConfig,
  type InputDevice,
  type LocalInputConfig,
  type PlayerBindings,
} from "./bindings";

/**
 * Editing and persistence for the peer's own LocalInputConfig (T12). A browser
 * stores only its own overrides in localStorage, keyed locally; it is never
 * shared with other peers. The host's InputConfig is only a default. Unknown or
 * corrupt payloads fall back to "no overrides" rather than half-loading.
 */

export const STORAGE_KEY = "wma.input.local";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Set one button's binding for one player slot, as a local override. */
export function rebind(
  base: InputConfig,
  local: LocalInputConfig,
  slot: number,
  button: Button,
  binding: Binding,
): LocalInputConfig {
  const inherited = local.players[slot] ?? base.players[slot];
  if (!inherited) return local;
  const players = [...local.players];
  players[slot] = { ...inherited, [button]: [binding] };
  return { ...local, players };
}

/** Override the device for a slot (null clears it). */
export function setDevice(
  local: LocalInputConfig,
  slot: number,
  device: InputDevice | null,
): LocalInputConfig {
  if (slot < 0 || slot >= PLAYER_SLOTS) return local;
  const devices = [...local.devices];
  devices[slot] = device;
  return { ...local, devices };
}

/** Drop every override for a slot, returning it to the host/default config. */
export function resetSlot(
  local: LocalInputConfig,
  slot: number,
): LocalInputConfig {
  if (slot < 0 || slot >= PLAYER_SLOTS) return local;
  const devices = [...local.devices];
  const players = [...local.players];
  devices[slot] = undefined;
  players[slot] = undefined;
  return { ...local, devices, players };
}

export function serializeLocalConfig(local: LocalInputConfig): string {
  // JSON has no `undefined`; "~inherit" keeps "follow the default" distinct
  // from `null` (explicitly cleared).
  return JSON.stringify({
    version: local.version,
    devices: local.devices.map((device) =>
      device === undefined ? INHERIT : device,
    ),
    players: local.players.map((player) =>
      player === undefined ? INHERIT : player,
    ),
  });
}

const INHERIT = "~inherit";

function isBinding(value: unknown): value is Binding {
  if (typeof value !== "object" || value === null) return false;
  const binding = value as Record<string, unknown>;
  if (binding.kind === "key") return typeof binding.code === "string";
  if (binding.kind === "gamepadButton") return typeof binding.index === "number";
  if (binding.kind === "gamepadAxis") {
    return (
      typeof binding.axis === "number" &&
      (binding.dir === "-" || binding.dir === "+")
    );
  }
  return false;
}

function isDevice(value: unknown): value is InputDevice {
  if (typeof value !== "object" || value === null) return false;
  const device = value as Record<string, unknown>;
  if (device.kind === "keyboard") return true;
  if (device.kind === "gamepad") return typeof device.index === "number";
  return false;
}

function isPlayerBindings(value: unknown): value is PlayerBindings {
  if (typeof value !== "object" || value === null) return false;
  const player = value as Record<string, unknown>;
  return ALL_BUTTONS.every(
    (button) =>
      Array.isArray(player[button]) &&
      (player[button] as unknown[]).every(isBinding),
  );
}

function toLocalInputConfig(value: unknown): LocalInputConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const local = value as Record<string, unknown>;
  if (local.version !== BINDINGS_VERSION) return null;
  if (!Array.isArray(local.devices) || local.devices.length !== PLAYER_SLOTS) {
    return null;
  }
  if (!Array.isArray(local.players) || local.players.length !== PLAYER_SLOTS) {
    return null;
  }

  const devices: (InputDevice | null | undefined)[] = [];
  for (const entry of local.devices) {
    if (entry === INHERIT) devices.push(undefined);
    else if (entry === null || isDevice(entry)) devices.push(entry);
    else return null;
  }

  const players: (PlayerBindings | undefined)[] = [];
  for (const entry of local.players) {
    if (entry === INHERIT) players.push(undefined);
    else if (isPlayerBindings(entry)) players.push(entry);
    else return null;
  }

  return { version: BINDINGS_VERSION, devices, players };
}

export function deserializeLocalConfig(raw: string): LocalInputConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_LOCAL_INPUT_CONFIG;
  }
  return toLocalInputConfig(parsed) ?? EMPTY_LOCAL_INPUT_CONFIG;
}

export function loadLocalConfig(storage: StorageLike): LocalInputConfig {
  const raw = storage.getItem(STORAGE_KEY);
  return raw === null ? EMPTY_LOCAL_INPUT_CONFIG : deserializeLocalConfig(raw);
}

export function saveLocalConfig(
  storage: StorageLike,
  local: LocalInputConfig,
): void {
  storage.setItem(STORAGE_KEY, serializeLocalConfig(local));
}
