import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROOM_BINDINGS,
  playerBindings,
  type RoomBindings,
} from "./bindings";
import {
  assignDevice,
  findConflicts,
  gamepadConnected,
  gamepadDisconnected,
  releaseDevice,
  sameDevice,
} from "./devices";

const empty = [null, null, null, null] as const;
const pad0 = { kind: "gamepad", index: 0 } as const;

describe("sameDevice", () => {
  it("matches identical devices and rejects others", () => {
    expect(sameDevice(pad0, { kind: "gamepad", index: 0 })).toBe(true);
    expect(sameDevice(pad0, { kind: "gamepad", index: 1 })).toBe(false);
    expect(sameDevice(pad0, { kind: "keyboard" })).toBe(false);
  });
});

describe("assignDevice", () => {
  it("fills the first empty slot when no slot is given", () => {
    expect(assignDevice(empty, pad0)).toEqual([
      pad0,
      null,
      null,
      null,
    ]);
  });

  it("uses the requested slot", () => {
    expect(assignDevice(empty, pad0, 2)).toEqual([
      null,
      null,
      pad0,
      null,
    ]);
  });

  it("moves a device out of its old slot when it is reassigned", () => {
    const before = [pad0, null, null, null] as const;
    expect(assignDevice(before, pad0, 2)).toEqual([
      null,
      null,
      pad0,
      null,
    ]);
  });

  it("leaves the slots unchanged when full and no slot is given", () => {
    const full = [
      { kind: "keyboard" },
      { kind: "gamepad", index: 0 },
      { kind: "gamepad", index: 1 },
      { kind: "gamepad", index: 2 },
    ] as const;
    expect(assignDevice(full, { kind: "gamepad", index: 3 })).toEqual(full);
  });
});

describe("releaseDevice", () => {
  it("clears the slot", () => {
    const before = [pad0, null, null, null] as const;
    expect(releaseDevice(before, 0)).toEqual(empty);
  });
});

describe("gamepad hot-plug", () => {
  it("assigns a new gamepad to the first free slot after the keyboard", () => {
    const room = gamepadConnected(DEFAULT_ROOM_BINDINGS, 0);
    expect(room.devices).toEqual([
      { kind: "keyboard" },
      pad0,
      null,
      null,
    ]);
  });

  it("does not assign the same index twice", () => {
    const once = gamepadConnected(DEFAULT_ROOM_BINDINGS, 0);
    const twice = gamepadConnected(once, 0);
    expect(twice.devices).toEqual(once.devices);
  });

  it("frees the slot on disconnect", () => {
    const connected = gamepadConnected(DEFAULT_ROOM_BINDINGS, 0);
    const released = gamepadDisconnected(connected, 0);
    expect(released.devices).toEqual([
      { kind: "keyboard" },
      null,
      null,
      null,
    ]);
  });

  it("ignores a disconnect for a pad that was never assigned", () => {
    expect(gamepadDisconnected(DEFAULT_ROOM_BINDINGS, 3).devices).toEqual(
      DEFAULT_ROOM_BINDINGS.devices,
    );
  });
});

describe("findConflicts", () => {
  it("returns nothing for the default room", () => {
    expect(findConflicts(DEFAULT_ROOM_BINDINGS)).toEqual([]);
  });

  it("reports a device assigned to two slots", () => {
    const room: RoomBindings = {
      ...DEFAULT_ROOM_BINDINGS,
      devices: [pad0, { kind: "gamepad", index: 0 }, null, null],
    };
    expect(findConflicts(room)).toEqual([
      { kind: "device", device: pad0, slots: [0, 1] },
    ]);
  });

  it("reports one binding on two buttons of the same player", () => {
    const players = [...DEFAULT_ROOM_BINDINGS.players];
    players[0] = playerBindings({
      b1: [{ kind: "key", code: "KeyZ" }],
      b2: [{ kind: "key", code: "KeyZ" }],
    });
    const room: RoomBindings = { ...DEFAULT_ROOM_BINDINGS, players };
    expect(findConflicts(room)).toEqual([
      {
        kind: "binding",
        slot: 0,
        binding: { kind: "key", code: "KeyZ" },
        buttons: ["b1", "b2"],
      },
    ]);
  });

  it("does not flag the same key on different players", () => {
    const players = [...DEFAULT_ROOM_BINDINGS.players];
    players[1] = playerBindings({ b1: [{ kind: "key", code: "Digit1" }] });
    const room: RoomBindings = { ...DEFAULT_ROOM_BINDINGS, players };
    expect(findConflicts(room)).toEqual([]);
  });
});
