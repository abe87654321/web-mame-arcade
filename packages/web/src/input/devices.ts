import type { Button } from "@wma/protocol";
import {
  ALL_BUTTONS,
  bindingKey,
  type Binding,
  type InputDevice,
  type InputConfig,
} from "./bindings";

/**
 * Device identity and conflict detection (T12). A device may belong to at most
 * one player slot; a binding may map to at most one button per player.
 */

export function sameDevice(a: InputDevice, b: InputDevice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "gamepad" && b.kind === "gamepad") return a.index === b.index;
  return true;
}

export type Conflict =
  | { kind: "device"; device: InputDevice; slots: number[] }
  | { kind: "binding"; slot: number; binding: Binding; buttons: Button[] };

/** Validate device uniqueness and per-player binding uniqueness. */
export function findConflicts(room: InputConfig): Conflict[] {
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
