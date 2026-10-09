import { describe, expect, it, vi } from "vitest";
import { BUTTON_BITS, PLAYER_SLOTS } from "@wma/protocol";
import type { Core } from "../core/types";
import type { GameEntry } from "../catalogue";
import type { GamepadsProvider } from "../input/gamepad";
import type { KeyboardTarget } from "../input/keyboard";
import type { UiDocument, UiElement } from "../ui/view";
import {
  createPlayController,
  type FrameScheduler,
} from "./play-controller";

const entry: GameEntry = {
  driver: "gridlee",
  title: "Gridlee",
  coreVersion: "a".repeat(64),
  mameCommit: "b".repeat(40),
  supportsSave: true,
  netplayMode: "lockstep",
  maxPlayers: 2,
  romLicensed: true,
  coreBaseUrl: "/static/cores/gridlee",
  romZipUrl: "/roms/gridlee.zip",
};

interface FakeElement extends UiElement {
  children: FakeElement[];
}

function fakeDoc(): UiDocument & { created: FakeElement[] } {
  const created: FakeElement[] = [];
  return {
    created,
    createElement(): UiElement {
      const el: FakeElement = {
        className: "",
        textContent: null,
        children: [],
        append(child) {
          el.children.push(child as FakeElement);
        },
        addEventListener() {},
      };
      created.push(el);
      return el;
    },
  };
}

function fakeScheduler(): FrameScheduler & { runNext(): void; pending(): number } {
  let next = 1;
  const callbacks = new Map<number, () => void>();
  return {
    request(callback) {
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
    runNext() {
      const first = callbacks.entries().next().value;
      if (first) {
        callbacks.delete(first[0]);
        first[1]();
      }
    },
    pending: () => callbacks.size,
  };
}

interface FakeKeyboard extends KeyboardTarget {
  fire(type: "keydown" | "keyup" | "blur", event?: unknown): void;
  listeners(type: string): number;
}

function fakeKeyboard(): FakeKeyboard {
  const map = new Map<string, Set<(event: unknown) => void>>();
  return {
    addEventListener(type, listener) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type)?.add(listener as (event: unknown) => void);
    },
    removeEventListener(type, listener) {
      map.get(type)?.delete(listener as (event: unknown) => void);
    },
    fire(type, event = {}) {
      for (const listener of map.get(type) ?? []) listener(event);
    },
    listeners: (type) => map.get(type)?.size ?? 0,
  };
}

function fakeGamepads(): GamepadsProvider {
  return { getGamepads: () => Array.from({ length: PLAYER_SLOTS }, () => null) };
}

function fakeCore(): Core & { load: ReturnType<typeof vi.fn>; step: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn(async () => {}),
    step: vi.fn(() => {
      throw new Error("stock core has no step");
    }),
    save: vi.fn(),
    hash: vi.fn(),
    readScore: vi.fn(),
    reset: vi.fn(),
    destroy: vi.fn(),
  } as unknown as Core & { load: ReturnType<typeof vi.fn>; step: ReturnType<typeof vi.fn> };
}

describe("createPlayController", () => {
  it("boots the core and mounts a canvas screen", () => {
    const doc = fakeDoc();
    const core = fakeCore();
    const controller = createPlayController({
      core,
      entry,
      document: doc,
      scheduler: fakeScheduler(),
      keyboard: fakeKeyboard(),
      gamepads: fakeGamepads(),
    });
    expect(core.load).toHaveBeenCalledOnce();
    expect(controller.screen.className).toBe("screen");
    controller.destroy();
  });

  it("samples inputs per frame and never steps the stock core", () => {
    const scheduler = fakeScheduler();
    const keyboard = fakeKeyboard();
    const core = fakeCore();
    const controller = createPlayController({
      core,
      entry,
      document: fakeDoc(),
      scheduler,
      keyboard,
      gamepads: fakeGamepads(),
    });

    keyboard.fire("keydown", { code: "KeyZ", preventDefault: vi.fn() });
    scheduler.runNext();
    expect(controller.inputs()).toEqual([BUTTON_BITS.b1, 0, 0, 0]);
    expect(core.step).not.toHaveBeenCalled();

    keyboard.fire("keyup", { code: "KeyZ" });
    scheduler.runNext();
    expect(controller.inputs()).toEqual([0, 0, 0, 0]);
    controller.destroy();
  });

  it("hands the sampled inputs to the lockstep when netplaying", () => {
    const scheduler = fakeScheduler();
    const keyboard = fakeKeyboard();
    const core = fakeCore();
    const lockstep = { tick: vi.fn() };
    createPlayController({
      core,
      entry,
      document: fakeDoc(),
      scheduler,
      keyboard,
      gamepads: fakeGamepads(),
      lockstep,
    });

    keyboard.fire("keydown", { code: "KeyZ", preventDefault: vi.fn() });
    scheduler.runNext();

    expect(lockstep.tick).toHaveBeenCalledWith([BUTTON_BITS.b1, 0, 0, 0]);
    expect(core.step).not.toHaveBeenCalled();
  });

  it("stops the loop and detaches listeners on destroy", () => {
    const scheduler = fakeScheduler();
    const keyboard = fakeKeyboard();
    const core = fakeCore();
    const controller = createPlayController({
      core,
      entry,
      document: fakeDoc(),
      scheduler,
      keyboard,
      gamepads: fakeGamepads(),
    });
    expect(scheduler.pending()).toBe(1);
    expect(keyboard.listeners("keydown")).toBe(1);

    controller.destroy();
    expect(scheduler.pending()).toBe(0);
    expect(keyboard.listeners("keydown")).toBe(0);
    expect(keyboard.listeners("keyup")).toBe(0);
    expect(core.destroy).toHaveBeenCalledOnce();
  });
});
