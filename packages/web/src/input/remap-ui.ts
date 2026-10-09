import { PLAYER_SLOTS, type Button } from "@wma/protocol";
import {
  ALL_BUTTONS,
  resolveInputConfig,
  type Binding,
  type InputConfig,
  type InputDevice,
  type LocalInputConfig,
} from "./bindings";
import { findConflicts, type Conflict } from "./devices";
import {
  rebind,
  resetSlot,
  saveLocalConfig,
  setDevice,
  type StorageLike,
} from "./remap";

/**
 * Remapping + device-assignment UI (T12). The controller owns this peer's local
 * overrides over the host/default config; the effective config is resolved on
 * demand. It is DOM-free (`view()` returns a plain tree, `renderTree` turns it
 * into elements through an injected UiDocument), so logic is unit-tested with a
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

/**
 * Real-DOM UiDocument adapter. Wraps created elements so `append` can unwrap
 * them back to Nodes; the UI code never sees the real DOM types.
 */
export function browserUiDocument(root: Document = document): UiDocument {
  return {
    createElement(tag: string): UiElement {
      const el = root.createElement(tag);
      const wrapper = {
        get className() {
          return el.className;
        },
        set className(value: string) {
          el.className = value;
        },
        get textContent() {
          return el.textContent;
        },
        set textContent(value: string | null) {
          el.textContent = value;
        },
        append(child: UiElement): void {
          el.append((child as unknown as { el: Element }).el);
        },
        addEventListener(
          type: "click",
          listener: (event: UiEvent) => void,
        ): void {
          el.addEventListener(type, listener as unknown as EventListener);
        },
      } as UiElement & { el: Element };
      wrapper.el = el;
      return wrapper;
    },
  };
}

export interface RemapUiOptions {
  /** Connected gamepad indices, for the assignment list. */
  gamepads?: readonly number[];
  /** Where this peer's local overrides are stored (per browser). */
  storage?: StorageLike;
  /** Called after every local change with the resolved config. */
  onChange?: (config: InputConfig) => void;
  /** Called after every local change; use to persist. */
  onSave?: (local: LocalInputConfig) => void;
}

export interface CaptureTarget {
  slot: number;
  button: Button;
}

export interface RemapUi {
  /** Effective config: host/default layered with this peer's overrides. */
  config(): InputConfig;
  /** This peer's own overrides. */
  local(): LocalInputConfig;
  gamepads(): readonly number[];
  status(): string;
  conflicts(): Conflict[];
  capture(): CaptureTarget | null;
  beginCapture(slot: number, button: Button): void;
  cancelCapture(): void;
  captureBinding(binding: Binding): boolean;
  setDevice(slot: number, device: InputDevice | null): void;
  assignKeyboard(slot: number): void;
  resetSlot(slot: number): void;
  connectGamepad(index: number): void;
  disconnectGamepad(index: number): void;
  view(): ViewNode;
}

export function createRemapUi(
  hostDefault: InputConfig,
  local: LocalInputConfig,
  options: RemapUiOptions = {},
): RemapUi {
  let overrides = local;
  let pads = [...(options.gamepads ?? [])];
  let status = "";
  let capture: CaptureTarget | null = null;

  const config = (): InputConfig => resolveInputConfig(hostDefault, overrides);

  const commit = (): void => {
    if (options.storage) saveLocalConfig(options.storage, overrides);
    options.onSave?.(overrides);
    options.onChange?.(config());
  };

  const applyBinding = (binding: Binding): boolean => {
    if (!capture) return false;
    const device = config().devices[capture.slot] ?? null;
    const kind =
      device === null ? "any" : device.kind === "keyboard" ? "keyboard" : "gamepad";
    const bindingKind = binding.kind === "key" ? "keyboard" : "gamepad";
    if (kind !== "any" && kind !== bindingKind) return false;
    overrides = rebind(
      hostDefault,
      overrides,
      capture.slot,
      capture.button,
      binding,
    );
    capture = null;
    commit();
    return true;
  };

  const players = (): ViewNode[] => {
    const resolved = config();
    return Array.from({ length: PLAYER_SLOTS }, (_, slot) => {
      const device = resolved.devices[slot] ?? null;
      const bindings = resolved.players[slot];
      const assignedPads = new Set(
        resolved.devices
          .filter(
            (d): d is { kind: "gamepad"; index: number } =>
              d?.kind === "gamepad",
          )
          .map((d) => d.index),
      );
      const controls: ViewNode[] = [
        {
          tag: "button",
          text: "use keyboard",
          onClick: () => ui.assignKeyboard(slot),
        },
        ...pads
          .filter((index) => !assignedPads.has(index))
          .map((index) => ({
            tag: "button",
            text: `assign gamepad ${index}`,
            onClick: () => ui.setDevice(slot, { kind: "gamepad", index }),
          })),
        { tag: "button", text: "clear", onClick: () => ui.setDevice(slot, null) },
        { tag: "button", text: "reset", onClick: () => ui.resetSlot(slot) },
      ];
      const rows: ViewNode[] = ALL_BUTTONS.map((button) => {
        const list = bindings?.[button] ?? [];
        const text = list.length
          ? list.map(describeBinding).join(", ")
          : "unbound";
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
      return {
        tag: "section",
        className: "player",
        children: [
          { tag: "h2", text: `P${slot + 1}` },
          { tag: "p", text: `device: ${describeDevice(device)}` },
          { tag: "div", className: "assign", children: controls },
          ...rows,
        ],
      };
    });
  };

  const ui: RemapUi = {
    config,
    local: () => overrides,
    gamepads: () => pads,
    status: () => status,
    conflicts: () => findConflicts(config()),
    capture: () => capture,
    beginCapture: (slot, button) => {
      capture = { slot, button };
    },
    cancelCapture: () => {
      capture = null;
    },
    captureBinding: applyBinding,
    setDevice: (slot, device) => {
      overrides = setDevice(overrides, slot, device);
      commit();
    },
    assignKeyboard: (slot) => {
      ui.setDevice(slot, { kind: "keyboard" });
    },
    resetSlot: (slot) => {
      overrides = resetSlot(overrides, slot);
      commit();
    },
    connectGamepad: (index) => {
      if (pads.includes(index)) return;
      pads = [...pads, index];
      const resolved = config();
      const known = resolved.devices.some(
        (d) => d?.kind === "gamepad" && d.index === index,
      );
      if (!known) {
        const free = resolved.devices.indexOf(null);
        if (free !== -1) {
          overrides = setDevice(overrides, free, {
            kind: "gamepad",
            index,
          });
        }
      }
      status = `gamepad ${index} connected`;
      commit();
    },
    disconnectGamepad: (index) => {
      if (!pads.includes(index)) return;
      pads = pads.filter((i) => i !== index);
      const resolved = config();
      resolved.devices.forEach((device, slot) => {
        if (device?.kind === "gamepad" && device.index === index) {
          overrides = setDevice(overrides, slot, null);
        }
      });
      status = `gamepad ${index} disconnected`;
      if (capture && config().devices[capture.slot] === null) capture = null;
      commit();
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
