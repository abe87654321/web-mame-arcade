import { PLAYER_SLOTS, type Button } from "@wma/protocol";
import {
  ALL_BUTTONS,
  BINDINGS_VERSION,
  DEFAULT_ROOM_BINDINGS,
  type Binding,
  type InputDevice,
  type PlayerBindings,
  type RoomBindings,
} from "./bindings";
import { assignDevice, releaseDevice } from "./devices";

/**
 * Editing and persistence for RoomBindings (T12). Remapping is host-local
 * configuration; it is stored in localStorage and never travels over the wire,
 * so it cannot affect determinism. Unknown or corrupt payloads fall back to
 * the defaults rather than half-loading.
 */

export const STORAGE_KEY = "wma.input.bindings";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Replace one button's bindings for one player slot. */
export function rebind(
  room: RoomBindings,
  slot: number,
  button: Button,
  binding: Binding,
): RoomBindings {
  const players = room.players.map((player, index) =>
    index === slot ? { ...player, [button]: [binding] } : player,
  );
  return { ...room, players };
}

/** Assign a device to a slot, or clear the slot when null. */
export function setDevice(
  room: RoomBindings,
  slot: number,
  device: InputDevice | null,
): RoomBindings {
  const devices = device
    ? assignDevice(room.devices, device, slot)
    : releaseDevice(room.devices, slot);
  return { ...room, devices };
}

export function serializeRoom(room: RoomBindings): string {
  return JSON.stringify(room);
}

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

function isRoomBindings(value: unknown): value is RoomBindings {
  if (typeof value !== "object" || value === null) return false;
  const room = value as Record<string, unknown>;
  if (room.version !== BINDINGS_VERSION) return false;
  if (!Array.isArray(room.devices) || room.devices.length !== PLAYER_SLOTS) {
    return false;
  }
  if (!room.devices.every((d) => d === null || isDevice(d))) return false;
  if (!Array.isArray(room.players) || room.players.length !== PLAYER_SLOTS) {
    return false;
  }
  return room.players.every(isPlayerBindings);
}

export function deserializeRoom(raw: string): RoomBindings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_ROOM_BINDINGS;
  }
  return isRoomBindings(parsed) ? parsed : DEFAULT_ROOM_BINDINGS;
}

export function loadRoom(storage: StorageLike): RoomBindings {
  const raw = storage.getItem(STORAGE_KEY);
  return raw === null ? DEFAULT_ROOM_BINDINGS : deserializeRoom(raw);
}

export function saveRoom(storage: StorageLike, room: RoomBindings): void {
  storage.setItem(STORAGE_KEY, serializeRoom(room));
}
