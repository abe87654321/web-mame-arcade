import { BUTTON_BITS, PLAYER_SLOTS, type Button } from "@wma/protocol";
import type { Binding, InputDevice, RoomBindings } from "./bindings";
import { gamepadConnected, gamepadDisconnected, findConflicts, type Conflict } from "./devices";
import { rebind, setDevice } from "./remap";

/**
 * Remapping + device-assignment UI (T12). The controller holds all state and
 * is DOM-free; `view()` returns a plain tree and `renderTree` turns it into
 * elements through an injected UiDocument, so the logic is unit-tested with a
 * fake DOM. Hot-plug events are handled here and surfaced as a status line.
 */

export interface UiEvent {
  preventDefault(): void;
}

export interface UiElement {
  className: string;
  textContent: string | null;
  append(child: UiElement): void;
  addEventListener(type: "click", listener: (event: UiEvent) => void): void;
}

export interface UiDocument {
  createElement(tag: string): UiElement;
}

export interface ViewNode {
  tag: string;
  className?: string;
  text?: string;
  children?: ViewNode[];
  onClick?: () => void;
}

export function describeBinding(binding: Binding): string {
  if (binding.kind === "key") return `key ${binding.code}`;
  if (binding.kind === "gamepadButton") return `pad button ${binding.index}`;
  return `pad axis ${binding.axis}${binding.dir}`;
}

export function describeDevice(device: InputDevice | null): string {
  if (device === null) return "none";
  if (device.kind === "keyboard") return "keyboard";
  return `gamepad ${device.index}`;
}

export function renderTree(doc: UiDocument, node: ViewNode): UiElement {
  const el = doc.createElement(node.tag);
  if (node.className) el.className = node.className;
  if (node.text !== undefined) el.textContent = node.text;
  if (node.onClick) {
    const handler = node.onClick;
    el.addEventListener("click", (event) => {
      event.preventDefault();
      handler();
    });
  }
  for (const child of node.children ?? []) {
    el.append(renderTree(doc, child));
  }
  return el;
}

export interface RemapUiOptions {
  gamepads?: readonly number[];
  onSave?: (room: RoomBindings) => void;
}

export interface CaptureTarget {
  slot: number;
  button: Button;
}

export interface RemapUi {
  room(): RoomBindings;
  gamepads(): readonly number[];
  status(): string;
  conflicts(): Conflict[];
  capture(): CaptureTarget | null;
  beginCapture(slot: number, button: Button): void;
  cancelCapture(): void;
  captureBinding(binding: Binding): boolean;
  setDevice(slot: number, device: InputDevice | null): void;
  connectGamepad(index: number): void;
  disconnectGamepad(index: number): void;
  view(): ViewNode;
}

export function createRemapUi(
  initial: RoomBindings,
  options: RemapUiOptions = {},
): RemapUi {
  let room = initial;
  let pads = [...(options.gamepads ?? [])];
  let status = "";
  let capture: CaptureTarget | null = null;

  const save = (): void => {
    options.onSave?.(room);
  };

  const keyBindingKind = (binding: Binding): "keyboard" | "gamepad" => {
    return binding.kind === "key" ? "keyboard" : "gamepad";
  };

  const players = (): ViewNode[] =>
    Array.from({ length: PLAYER_SLOTS }, (_, slot) => {
      const device = room.devices[slot] ?? null;
      const bindings = room.players[slot];
      const buttons = Object.keys(BUTTON_BITS) as Button[];
      const bindingRows: ViewNode[] = buttons.map((button) => {
        const list = bindings?.[button] ?? [];
        const text = list.length ? list.map(describeBinding).join(", ") : "unbound";
        return {
          tag: "div",
          className: "binding",
          children: [
            { tag: "span", text: `${button}: ${text}` },
            {
              tag: "button",
              text: "rebind",
              onClick: () => ui.beginCapture(slot, button),
            },
          ],
        };
      });
      const assignButtons: ViewNode[] = pads
        .filter(
          (index) =>
            !room.devices.some(
              (d) => d?.kind === "gamepad" && d.index === index,
            ),
        )
        .map((index) => ({
          tag: "button",
          text: `assign gamepad ${index}`,
          onClick: () => ui.setDevice(slot, { kind: "gamepad", index }),
        }));
      return {
        tag: "section",
        className: "player",
        children: [
          { tag: "h2", text: `P${slot + 1}` },
          { tag: "p", text: `device: ${describeDevice(device)}` },
          { tag: "div", className: "assign", children: assignButtons },
          ...bindingRows,
        ],
      };
    });

  const ui: RemapUi = {
    room: () => room,
    gamepads: () => pads,
    status: () => status,
    conflicts: () => findConflicts(room),
    capture: () => capture,
    beginCapture: (slot, button) => {
      capture = { slot, button };
    },
    cancelCapture: () => {
      capture = null;
    },
    captureBinding: (binding) => {
      if (!capture) return false;
      const device = room.devices[capture.slot] ?? null;
      const expected = device?.kind === "keyboard" ? "keyboard" : "gamepad";
      if (keyBindingKind(binding) !== expected) return false;
      room = rebind(room, capture.slot, capture.button, binding);
      capture = null;
      save();
      return true;
    },
    setDevice: (slot, device) => {
      room = setDevice(room, slot, device);
      save();
    },
    connectGamepad: (index) => {
      if (pads.includes(index)) return;
      pads = [...pads, index];
      room = gamepadConnected(room, index);
      status = `gamepad ${index} connected`;
      save();
    },
    disconnectGamepad: (index) => {
      if (!pads.includes(index)) return;
      pads = pads.filter((i) => i !== index);
      room = gamepadDisconnected(room, index);
      status = `gamepad ${index} disconnected`;
      if (capture && room.devices[capture.slot] === null) capture = null;
      save();
    },
    view: () => {
      const conflicts = ui.conflicts();
      const conflictNodes: ViewNode[] =
        conflicts.length === 0
          ? []
          : [
              {
                tag: "ul",
                className: "conflicts",
                children: conflicts.map((conflict) => ({
                  tag: "li",
                  text:
                    conflict.kind === "device"
                      ? `${describeDevice(conflict.device)} assigned to slots ${conflict.slots.join(", ")}`
                      : `${describeBinding(conflict.binding)} bound to ${conflict.buttons.join(", ")}`,
                })),
              },
            ];
      const captureNode: ViewNode[] = capture
        ? [
            {
              tag: "p",
              className: "capture",
              text: `press a control to bind ${capture.button} on P${capture.slot + 1}`,
            },
          ]
        : [];
      return {
        tag: "div",
        className: "remap",
        children: [
          { tag: "p", className: "status", text: status },
          ...captureNode,
          ...conflictNodes,
          ...players(),
        ],
      };
    },
  };

  return ui;
}
