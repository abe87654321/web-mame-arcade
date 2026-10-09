import { describe, expect, it, vi } from "vitest";
import {
  BINDINGS_VERSION,
  DEFAULT_ROOM_BINDINGS,
} from "./bindings";
import {
  STORAGE_KEY,
  deserializeRoom,
  loadRoom,
  rebind,
  saveRoom,
  serializeRoom,
  setDevice,
  type StorageLike,
} from "./remap";

function fakeStorage(initial: Record<string, string> = {}): StorageLike {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe("rebind", () => {
  it("changes one button for one player only", () => {
    const next = rebind(DEFAULT_ROOM_BINDINGS, 1, "b1", {
      kind: "gamepadButton",
      index: 7,
    });
    expect(next.players[1]?.b1).toEqual([{ kind: "gamepadButton", index: 7 }]);
    expect(next.players[1]?.b2).toEqual(DEFAULT_ROOM_BINDINGS.players[1]?.b2);
    expect(next.players[0]).toBe(DEFAULT_ROOM_BINDINGS.players[0]);
  });

  it("accepts a keyboard binding", () => {
    const next = rebind(DEFAULT_ROOM_BINDINGS, 0, "start", {
      kind: "key",
      code: "Enter",
    });
    expect(next.players[0]?.start).toEqual([{ kind: "key", code: "Enter" }]);
  });
});

describe("setDevice", () => {
  it("assigns a gamepad to a slot", () => {
    const next = setDevice(DEFAULT_ROOM_BINDINGS, 2, {
      kind: "gamepad",
      index: 0,
    });
    expect(next.devices[2]).toEqual({ kind: "gamepad", index: 0 });
  });

  it("clears a slot when passed null", () => {
    const next = setDevice(DEFAULT_ROOM_BINDINGS, 0, null);
    expect(next.devices[0]).toBeNull();
  });
});

describe("serializeRoom / deserializeRoom", () => {
  it("round-trips a room", () => {
    const room = rebind(DEFAULT_ROOM_BINDINGS, 3, "coin", {
      kind: "gamepadButton",
      index: 6,
    });
    expect(deserializeRoom(serializeRoom(room))).toEqual(room);
  });

  it("falls back to the default on malformed JSON", () => {
    expect(deserializeRoom("{not json")).toBe(DEFAULT_ROOM_BINDINGS);
  });

  it("falls back to the default on an unknown version", () => {
    const raw = JSON.stringify({ ...DEFAULT_ROOM_BINDINGS, version: 99 });
    expect(deserializeRoom(raw)).toBe(DEFAULT_ROOM_BINDINGS);
  });

  it("falls back to the default on a wrong-shaped payload", () => {
    const raw = JSON.stringify({ version: BINDINGS_VERSION, devices: [], players: [] });
    expect(deserializeRoom(raw)).toBe(DEFAULT_ROOM_BINDINGS);
  });
});

describe("loadRoom / saveRoom", () => {
  it("saves then loads the same room", () => {
    const storage = fakeStorage();
    saveRoom(storage, DEFAULT_ROOM_BINDINGS);
    expect(loadRoom(storage)).toEqual(DEFAULT_ROOM_BINDINGS);
  });

  it("returns the default when nothing is stored", () => {
    expect(loadRoom(fakeStorage())).toBe(DEFAULT_ROOM_BINDINGS);
  });

  it("uses a stable storage key", () => {
    const setItem = vi.fn();
    saveRoom({ getItem: () => null, setItem }, DEFAULT_ROOM_BINDINGS);
    expect(setItem).toHaveBeenCalledWith(STORAGE_KEY, expect.any(String));
  });
});
