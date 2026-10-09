import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ROOM_BINDINGS, type RoomBindings } from "./bindings";
import {
  createRemapUi,
  describeBinding,
  describeDevice,
  renderTree,
  type UiDocument,
  type UiElement,
  type ViewNode,
} from "./remap-ui";

describe("describeBinding", () => {
  it("names each binding kind", () => {
    expect(describeBinding({ kind: "key", code: "KeyZ" })).toBe("key KeyZ");
    expect(describeBinding({ kind: "gamepadButton", index: 3 })).toBe(
      "pad button 3",
    );
    expect(describeBinding({ kind: "gamepadAxis", axis: 0, dir: "-" })).toBe(
      "pad axis 0-",
    );
  });
});

describe("describeDevice", () => {
  it("names each device state", () => {
    expect(describeDevice(null)).toBe("none");
    expect(describeDevice({ kind: "keyboard" })).toBe("keyboard");
    expect(describeDevice({ kind: "gamepad", index: 2 })).toBe("gamepad 2");
  });
});

describe("RemapUi controller", () => {
  it("rebinds the captured button for a keyboard player and saves", () => {
    const onSave = vi.fn();
    const ui = createRemapUi(DEFAULT_ROOM_BINDINGS, { onSave });
    ui.beginCapture(0, "start");
    expect(ui.capture()).toEqual({ slot: 0, button: "start" });
    expect(ui.captureBinding({ kind: "key", code: "Enter" })).toBe(true);
    expect(ui.room().players[0]?.start).toEqual([{ kind: "key", code: "Enter" }]);
    expect(ui.capture()).toBeNull();
    expect(onSave).toHaveBeenCalledWith(ui.room());
  });

  it("rejects a gamepad binding while capturing on a keyboard slot", () => {
    const ui = createRemapUi(DEFAULT_ROOM_BINDINGS);
    ui.beginCapture(0, "b1");
    expect(ui.captureBinding({ kind: "gamepadButton", index: 0 })).toBe(false);
    expect(ui.capture()).toEqual({ slot: 0, button: "b1" });
  });

  it("rebinds a gamepad player to a gamepad button", () => {
    const ui = createRemapUi(DEFAULT_ROOM_BINDINGS);
    ui.setDevice(1, { kind: "gamepad", index: 0 });
    ui.beginCapture(1, "b2");
    expect(ui.captureBinding({ kind: "gamepadButton", index: 6 })).toBe(true);
    expect(ui.room().players[1]?.b2).toEqual([
      { kind: "gamepadButton", index: 6 },
    ]);
  });

  it("cancels capture without changing bindings", () => {
    const ui = createRemapUi(DEFAULT_ROOM_BINDINGS);
    ui.beginCapture(0, "b1");
    ui.cancelCapture();
    expect(ui.capture()).toBeNull();
    expect(ui.captureBinding({ kind: "key", code: "Enter" })).toBe(false);
  });

  it("assigns and clears devices", () => {
    const ui = createRemapUi(DEFAULT_ROOM_BINDINGS);
    ui.setDevice(2, { kind: "gamepad", index: 0 });
    expect(ui.room().devices[2]).toEqual({ kind: "gamepad", index: 0 });
    ui.setDevice(2, null);
    expect(ui.room().devices[2]).toBeNull();
  });

  it("handles gamepad hot-plug and reports status", () => {
    const ui = createRemapUi(DEFAULT_ROOM_BINDINGS);
    ui.connectGamepad(0);
    expect(ui.gamepads()).toEqual([0]);
    expect(ui.room().devices[1]).toEqual({ kind: "gamepad", index: 0 });
    expect(ui.status()).toContain("0");

    ui.disconnectGamepad(0);
    expect(ui.gamepads()).toEqual([]);
    expect(ui.room().devices[1]).toBeNull();
    expect(ui.status()).toContain("0");
  });

  it("ignores a duplicate connect for the same index", () => {
    const ui = createRemapUi(DEFAULT_ROOM_BINDINGS);
    ui.connectGamepad(1);
    ui.connectGamepad(1);
    expect(ui.gamepads()).toEqual([1]);
    expect(ui.room().devices[1]).toEqual({ kind: "gamepad", index: 1 });
    expect(ui.room().devices[2]).toBeNull();
  });

  it("surfaces conflicts from the loaded room", () => {
    const dup: RoomBindings = {
      ...DEFAULT_ROOM_BINDINGS,
      devices: [
        { kind: "gamepad", index: 0 },
        { kind: "gamepad", index: 0 },
        null,
        null,
      ],
    };
    expect(createRemapUi(dup).conflicts().length).toBeGreaterThan(0);
  });

  it("builds a view with a section per player and the status line", () => {
    const ui = createRemapUi(DEFAULT_ROOM_BINDINGS);
    ui.connectGamepad(0);
    const view = ui.view();
    expect(view.children?.some((c) => c.className === "status")).toBe(true);
    const players = view.children?.filter((c) => c.className === "player") ?? [];
    expect(players).toHaveLength(4);
    expect(JSON.stringify(view)).toContain("P1");
  });
});

class FakeEl {
  className = "";
  textContent: string | null = null;
  readonly children: FakeEl[] = [];
  private readonly listeners: Record<string, ((event: { preventDefault(): void }) => void)[]> = {};
  constructor(readonly tag: string) {}
  append(child: UiElement): void {
    this.children.push(child as FakeEl);
  }
  addEventListener(
    type: "click",
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    (this.listeners[type] ??= []).push(listener);
  }
  click(): void {
    for (const listener of this.listeners.click ?? []) {
      listener({ preventDefault: () => {} });
    }
  }
}

class FakeDoc implements UiDocument {
  createElement(tag: string): UiElement {
    return new FakeEl(tag);
  }
}

describe("renderTree", () => {
  it("creates the element tree with classes, text and click handlers", () => {
    const onClick = vi.fn();
    const node: ViewNode = {
      tag: "div",
      className: "root",
      children: [
        { tag: "span", text: "hi" },
        { tag: "button", text: "go", onClick },
      ],
    };
    const el = renderTree(new FakeDoc(), node) as FakeEl;
    expect(el.tag).toBe("div");
    expect(el.className).toBe("root");
    expect(el.children.map((c) => c.tag)).toEqual(["span", "button"]);
    expect(el.children[0]?.textContent).toBe("hi");
    (el.children[1] as FakeEl).click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
