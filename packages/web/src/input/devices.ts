import type { Button } from "@wma/protocol";
import {
  ALL_BUTTONS,
  bindingKey,
  type Binding,
  type DeviceSlots,
  type InputDevice,
  type RoomBindings,
} from "./bindings";

/**
 * Device assignment and conflict detection (T12). A device may belong to at
 * most one player slot; a binding may map to at most one button per player.
 */

export function sameDevice(a: InputDevice, b: InputDevice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "gamepad" && b.kind === "gamepad") return a.index === b.index;
  return true;
}

export function sameBinding(a: Binding, b: Binding): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "key" && b.kind === "key") return a.code === b.code;
  if (a.kind === "gamepadButton" && b.kind === "gamepadButton") {
    return a.index === b.index;
  }
  if (a.kind === "gamepadAxis" && b.kind === "gamepadAxis") {
    return a.axis === b.axis && a.dir === b.dir;
  }
  return false;
}

/** Drop a device from every slot (its prior home). */
function removeDevice(devices: readonly (InputDevice | null)[], device: InputDevice) {
  return devices.map((slot) => (slot && sameDevice(slot, device) ? null : slot));
}

/**
 * Assign a device to a slot, removing it from any slot it occupied before.
 * Without an explicit slot, the first empty slot is used. If the slots are
 * full and no slot is requested, the assignment is left unchanged.
 */
export function assignDevice(
  devices: DeviceSlots,
  device: InputDevice,
  slot?: number,
): DeviceSlots {
  const cleared = removeDevice(devices, device);
  if (slot !== undefined) {
    const next = [...cleared];
    next[slot] = device;
    return next;
  }
  const free = cleared.indexOf(null);
  if (free === -1) return devices;
  const next = [...cleared];
  next[free] = device;
  return next;
}

/** Free a slot. */
export function releaseDevice(devices: DeviceSlots, slot: number): DeviceSlots {
  return devices.map((d, i) => (i === slot ? null : d));
}

/** Assign a freshly connected gamepad to the first free slot, unless known. */
export function gamepadConnected(room: RoomBindings, index: number): RoomBindings {
  const device: InputDevice = { kind: "gamepad", index };
  if (room.devices.some((slot) => slot && sameDevice(slot, device))) {
    return room;
  }
  return { ...room, devices: assignDevice(room.devices, device) };
}

/** Free whichever slot held the disconnected gamepad. */
export function gamepadDisconnected(
  room: RoomBindings,
  index: number,
): RoomBindings {
  const device: InputDevice = { kind: "gamepad", index };
  const devices = room.devices.map((slot) =>
    slot && sameDevice(slot, device) ? null : slot,
  );
  return { ...room, devices };
}

export type Conflict =
  | { kind: "device"; device: InputDevice; slots: number[] }
  | { kind: "binding"; slot: number; binding: Binding; buttons: Button[] };

/** Validate device uniqueness and per-player binding uniqueness. */
export function findConflicts(room: RoomBindings): Conflict[] {
  const conflicts: Conflict[] = [];

  const deviceSlots = new Map<string, number[]>();
  room.devices.forEach((device, slot) => {
    if (!device) return;
    const key = device.kind === "keyboard" ? "keyboard" : `gamepad:${device.index}`;
    const list = deviceSlots.get(key) ?? [];
    list.push(slot);
    deviceSlots.set(key, list);
  });
  room.devices.forEach((device, slot) => {
    if (!device) return;
    const key = device.kind === "keyboard" ? "keyboard" : `gamepad:${device.index}`;
    const slots = deviceSlots.get(key);
    if (slots && slots.length > 1 && slots[0] === slot) {
      conflicts.push({ kind: "device", device, slots });
    }
  });

  room.players.forEach((player, slot) => {
    const byBinding = new Map<string, { binding: Binding; buttons: Button[] }>();
    for (const button of ALL_BUTTONS) {
      for (const binding of player[button]) {
        const key = bindingKey(binding);
        const entry = byBinding.get(key) ?? { binding, buttons: [] };
        entry.buttons.push(button);
        byBinding.set(key, entry);
      }
    }
    for (const { binding, buttons: bound } of byBinding.values()) {
      if (bound.length > 1) {
        conflicts.push({ kind: "binding", slot, binding, buttons: bound });
      }
    }
  });

  return conflicts;
}
