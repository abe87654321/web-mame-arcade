import { describe, expect, it } from "vitest";
import { createInputSetup } from "./setup";
import type { GamepadLike } from "./gamepad";
import type { StorageLike } from "./remap";

function pad(index: number): GamepadLike {
  return { index, mapping: "standard", connected: true, buttons: [], axes: [] };
}

function fakeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

function fakePads(initial: GamepadLike[]): {
  provider: { getGamepads(): (GamepadLike | null)[] };
  set(list: GamepadLike[]): void;
} {
  let list = initial;
  return {
    provider: { getGamepads: () => list },
    set: (next) => void (list = next),
  };
}

type GamepadEventName = "gamepadconnected" | "gamepaddisconnected";

interface EventTargetLike {
  addEventListener(
    type: GamepadEventName,
    listener: (event: { gamepad: GamepadLike }) => void,
  ): void;
  removeEventListener(): void;
  fire(type: GamepadEventName, index: number): void;
}

function fakeEvents(): EventTargetLike {
  const listeners: Record<GamepadEventName, Array<(event: { gamepad: GamepadLike }) => void>> = {
    gamepadconnected: [],
    gamepaddisconnected: [],
  };
  return {
    addEventListener: (type, listener) => void listeners[type].push(listener),
    removeEventListener: () => {},
    fire: (type, index) =>
      listeners[type].forEach((listener) => listener({ gamepad: pad(index) })),
  };
}

describe("createInputSetup", () => {
  it("assigns the first connected pad to P1 while P1 is the default keyboard", () => {
    const pads = fakePads([pad(0)]);
    const setup = createInputSetup({ gamepads: pads.provider, storage: fakeStorage() });
    setup.attach();
    expect(setup.config().devices[0]).toEqual({ kind: "gamepad", index: 0 });
  });

  it("assigns the second pad to P2 (first free slot)", () => {
    const pads = fakePads([pad(0), pad(1)]);
    const setup = createInputSetup({ gamepads: pads.provider, storage: fakeStorage() });
    setup.attach();
    expect(setup.config().devices[0]).toEqual({ kind: "gamepad", index: 0 });
    expect(setup.config().devices[1]).toEqual({ kind: "gamepad", index: 1 });
  });

  it("handles a pad hot-plugged after startup", () => {
    const pads = fakePads([]);
    const events = fakeEvents();
    const setup = createInputSetup({
      gamepads: pads.provider,
      events,
      storage: fakeStorage(),
    });
    setup.attach();
    pads.set([pad(0)]);
    events.fire("gamepadconnected", 0);
    expect(setup.config().devices[0]).toEqual({ kind: "gamepad", index: 0 });
  });

  it("persists assignment to storage so it survives a reload", () => {
    const storage = fakeStorage();
    const pads = fakePads([pad(2)]);
    const first = createInputSetup({ gamepads: pads.provider, storage });
    first.attach();
    const second = createInputSetup({ gamepads: fakePads([]).provider, storage });
    expect(second.config().devices[0]).toEqual({ kind: "gamepad", index: 2 });
  });
});
