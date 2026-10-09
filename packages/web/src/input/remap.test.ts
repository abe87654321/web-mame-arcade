import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INPUT_CONFIG,
  EMPTY_LOCAL_INPUT_CONFIG,
  resolveInputConfig,
  type LocalInputConfig,
} from "./bindings";
import {
  STORAGE_KEY,
  deserializeLocalConfig,
  loadLocalConfig,
  rebind,
  resetSlot,
  saveLocalConfig,
  serializeLocalConfig,
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
  it("overrides one button for one player slot only", () => {
    const local = rebind(DEFAULT_INPUT_CONFIG, EMPTY_LOCAL_INPUT_CONFIG, 1, "b1", {
      kind: "gamepadButton",
      index: 7,
    });
    const resolved = resolveInputConfig(DEFAULT_INPUT_CONFIG, local);
    expect(resolved.players[1]?.b1).toEqual([
      { kind: "gamepadButton", index: 7 },
    ]);
    expect(resolved.players[1]?.b2).toEqual(
      DEFAULT_INPUT_CONFIG.players[1]?.b2,
    );
    expect(resolved.players[0]).toBe(DEFAULT_INPUT_CONFIG.players[0]);
  });

  it("does not mutate the base or the previous local config", () => {
    rebind(DEFAULT_INPUT_CONFIG, EMPTY_LOCAL_INPUT_CONFIG, 0, "start", {
      kind: "key",
      code: "Enter",
    });
    expect(DEFAULT_INPUT_CONFIG.players[0]?.start).toEqual([
      { kind: "key", code: "Digit1" },
    ]);
    expect(EMPTY_LOCAL_INPUT_CONFIG.players[0]).toBeUndefined();
  });

  it("accepts a keyboard binding", () => {
    const local = rebind(DEFAULT_INPUT_CONFIG, EMPTY_LOCAL_INPUT_CONFIG, 0, "start", {
      kind: "key",
      code: "Enter",
    });
    expect(
      resolveInputConfig(DEFAULT_INPUT_CONFIG, local).players[0]?.start,
    ).toEqual([{ kind: "key", code: "Enter" }]);
  });
});

describe("setDevice", () => {
  it("overrides a slot's device", () => {
    const local = setDevice(EMPTY_LOCAL_INPUT_CONFIG, 2, {
      kind: "gamepad",
      index: 0,
    });
    expect(resolveInputConfig(DEFAULT_INPUT_CONFIG, local).devices[2]).toEqual({
      kind: "gamepad",
      index: 0,
    });
  });

  it("clears a slot with null", () => {
    const local = setDevice(EMPTY_LOCAL_INPUT_CONFIG, 0, null);
    expect(
      resolveInputConfig(DEFAULT_INPUT_CONFIG, local).devices[0],
    ).toBeNull();
  });
});

describe("resetSlot", () => {
  it("drops overrides so the slot follows the host default again", () => {
    let local = setDevice(EMPTY_LOCAL_INPUT_CONFIG, 0, null);
    local = rebind(DEFAULT_INPUT_CONFIG, local, 0, "b1", {
      kind: "key",
      code: "KeyP",
    });
    local = resetSlot(local, 0);
    expect(resolveInputConfig(DEFAULT_INPUT_CONFIG, local).devices[0]).toEqual(
      { kind: "keyboard" },
    );
    expect(
      resolveInputConfig(DEFAULT_INPUT_CONFIG, local).players[0]?.b1,
    ).toEqual(DEFAULT_INPUT_CONFIG.players[0]?.b1);
  });
});

describe("serialize / deserialize", () => {
  it("round-trips local overrides", () => {
    const local = setDevice(EMPTY_LOCAL_INPUT_CONFIG, 3, {
      kind: "gamepad",
      index: 2,
    });
    expect(deserializeLocalConfig(serializeLocalConfig(local))).toEqual(local);
  });

  it("round-trips an explicit null (clear) separately from inherit", () => {
    const local = setDevice(EMPTY_LOCAL_INPUT_CONFIG, 0, null);
    const restored = deserializeLocalConfig(serializeLocalConfig(local));
    expect(restored.devices[0]).toBeNull();
    expect(restored.devices[1]).toBeUndefined();
    expect(restored).toEqual(local);
  });

  it("falls back to empty overrides on malformed JSON", () => {
    expect(deserializeLocalConfig("{not json")).toBe(EMPTY_LOCAL_INPUT_CONFIG);
  });

  it("falls back on an unknown version", () => {
    const raw = JSON.stringify({ ...EMPTY_LOCAL_INPUT_CONFIG, version: 99 });
    expect(deserializeLocalConfig(raw)).toBe(EMPTY_LOCAL_INPUT_CONFIG);
  });

  it("falls back on a wrong-shaped payload", () => {
    const raw = JSON.stringify({ version: 1, devices: [], players: [] });
    expect(deserializeLocalConfig(raw)).toBe(EMPTY_LOCAL_INPUT_CONFIG);
  });
});

describe("load / save", () => {
  it("saves then loads the same overrides", () => {
    const storage = fakeStorage();
    const local: LocalInputConfig = setDevice(EMPTY_LOCAL_INPUT_CONFIG, 1, {
      kind: "gamepad",
      index: 0,
    });
    saveLocalConfig(storage, local);
    expect(loadLocalConfig(storage)).toEqual(local);
  });

  it("returns empty overrides when nothing is stored", () => {
    expect(loadLocalConfig(fakeStorage())).toBe(EMPTY_LOCAL_INPUT_CONFIG);
  });

  it("uses a stable per-browser storage key", () => {
    const setItem = vi.fn();
    saveLocalConfig({ getItem: () => null, setItem }, EMPTY_LOCAL_INPUT_CONFIG);
    expect(setItem).toHaveBeenCalledWith(STORAGE_KEY, expect.any(String));
  });

  it("keeps each peer's overrides independent of every other peer", () => {
    const peerA = fakeStorage();
    const peerB = fakeStorage();
    saveLocalConfig(
      peerA,
      setDevice(EMPTY_LOCAL_INPUT_CONFIG, 1, { kind: "gamepad", index: 0 }),
    );
    const resolvedA = resolveInputConfig(DEFAULT_INPUT_CONFIG, loadLocalConfig(peerA));
    const resolvedB = resolveInputConfig(DEFAULT_INPUT_CONFIG, loadLocalConfig(peerB));
    expect(resolvedA.devices[1]).toEqual({ kind: "gamepad", index: 0 });
    expect(resolvedB.devices[1]).toBeNull();
    expect(resolvedB.players[0]).toBe(DEFAULT_INPUT_CONFIG.players[0]);
  });
});
