import { describe, expect, it } from "vitest";
import { PLAYER_SLOTS } from "@wma/protocol";
import { RelayError, RoomManager } from "./room";
import { TokenError, type TokenClaims, type TokenVerifier } from "./token";

/** Token format for tests: `<sub>` or `<sub>@<name>`; `bad` always fails. */
const fakeVerifier: TokenVerifier = {
  verify(token: string): TokenClaims {
    if (token === "bad") throw new TokenError("nope");
    const [sub, name] = token.split("@");
    if (!sub) throw new TokenError("nope");
    return name ? { sub, name, exp: 9_999_999_999 } : { sub, exp: 9_999_999_999 };
  },
};

function manager() {
  return new RoomManager(fakeVerifier);
}

describe("RoomManager.join", () => {
  it("seats players in the lowest free slot", () => {
    const rooms = manager();
    expect(rooms.join("c1", { room: "r", role: "player", token: "alice" }).slot).toBe(0);
    expect(rooms.join("c2", { room: "r", role: "player", token: "bob" }).slot).toBe(1);
    expect(rooms.join("c3", { room: "r", role: "player", token: "carol" }).slot).toBe(2);
  });

  it("rejects the player that would exceed the slots", () => {
    const rooms = manager();
    for (let i = 0; i < PLAYER_SLOTS; i++) {
      rooms.join(`c${i}`, { room: "r", role: "player", token: `u${i}` });
    }
    try {
      rooms.join("overflow", { room: "r", role: "player", token: "late" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RelayError);
      expect((error as RelayError).code).toBe("room_full");
    }
  });

  it("lets viewers in beyond the player slots with no slot", () => {
    const rooms = manager();
    for (let i = 0; i < PLAYER_SLOTS; i++) {
      rooms.join(`c${i}`, { room: "r", role: "player", token: `u${i}` });
    }
    const viewer = rooms.join("c9", { room: "r", role: "viewer", token: "watcher" });
    expect(viewer.slot).toBeNull();
    expect(viewer.role).toBe("viewer");
  });

  it("propagates a token failure without seating anyone", () => {
    const rooms = manager();
    expect(() => rooms.join("c1", { room: "r", role: "player", token: "bad" })).toThrow(
      TokenError,
    );
    expect(rooms.roomIdOf("c1")).toBeUndefined();
  });

  it("reuses the slot when the same user reconnects", () => {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "player", token: "alice" });
    const rejoin = rooms.join("c2", { room: "r", role: "player", token: "alice" });
    expect(rejoin.slot).toBe(0);
    expect(rooms.roomIdOf("c1")).toBeUndefined();
    expect(rooms.broadcastTargets("r")).toEqual(["c2"]);
  });

  it("rejects joining a second room on the same connection", () => {
    const rooms = manager();
    rooms.join("c1", { room: "a", role: "player", token: "alice" });
    try {
      rooms.join("c1", { room: "b", role: "player", token: "alice" });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("already_joined");
    }
    expect(rooms.roomIdOf("c1")).toBe("a");
    expect(rooms.broadcastTargets("b")).toEqual([]);
  });

  it("re-seats a viewer as a player when the role changes", () => {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "viewer", token: "alice" });
    const rejoin = rooms.join("c2", { room: "r", role: "player", token: "alice" });
    expect(rejoin).toMatchObject({ role: "player", slot: 0 });
    expect(rooms.snapshot("c2").players).toEqual([{ slot: 0, name: "player" }]);
  });

  it("keeps the exact slot when a user reconnects through a hole", () => {
    const rooms = manager();
    rooms.join("c0", { room: "r", role: "player", token: "u0" });
    rooms.join("c1", { room: "r", role: "player", token: "u1" });
    rooms.join("c2", { room: "r", role: "player", token: "u2" });
    rooms.leave("c1");
    const rejoin = rooms.join("c2b", { room: "r", role: "player", token: "u2" });
    expect(rejoin.slot).toBe(2);
  });

  it("keeps membership when a role switch is rejected as room_full", () => {
    const rooms = manager();
    for (let i = 0; i < PLAYER_SLOTS; i++) {
      rooms.join(`p${i}`, { room: "r", role: "player", token: `u${i}` });
    }
    rooms.join("v1", { room: "r", role: "viewer", token: "watcher" });
    expect(() =>
      rooms.join("v2", { room: "r", role: "player", token: "watcher" }),
    ).toThrow(RelayError);
    expect(rooms.roomIdOf("v1")).toBe("r");
    expect(rooms.broadcastTargets("r")).toContain("v1");
  });

  it("applies a role change on the same connection", () => {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "viewer", token: "alice" });
    const changed = rooms.join("c1", { room: "r", role: "player", token: "alice" });
    expect(changed).toMatchObject({ role: "player", slot: 0 });
  });
});

describe("RoomManager.leave", () => {
  it("frees the slot for the next player", () => {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "player", token: "alice" });
    rooms.join("c2", { room: "r", role: "player", token: "bob" });
    rooms.leave("c1");
    const next = rooms.join("c3", { room: "r", role: "player", token: "carol" });
    expect(next.slot).toBe(0);
  });

  it("drops an emptied room", () => {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "viewer", token: "alice" });
    rooms.leave("c1");
    expect(rooms.roomIdOf("c1")).toBeUndefined();
    expect(rooms.broadcastTargets("r")).toEqual([]);
  });
});

describe("RoomManager.signal", () => {
  function seated() {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "player", token: "alice" });
    rooms.join("c2", { room: "r", role: "player", token: "bob" });
    rooms.join("c9", { room: "r", role: "viewer", token: "watcher" });
    return rooms;
  }

  it("routes to the connection seated in the target slot", () => {
    expect(seated().signal("c1", { t: "rtc.signal", to: 1 })).toBe("c2");
  });

  it("rejects an unoccupied slot", () => {
    try {
      seated().signal("c1", { t: "rtc.signal", to: 3 });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("unknown_peer");
    }
  });

  it("rejects a sender that never joined", () => {
    try {
      seated().signal("ghost", { t: "rtc.signal", to: 0 });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_joined");
    }
  });

  it("keeps rooms isolated", () => {
    const rooms = seated();
    rooms.join("x1", { room: "other", role: "player", token: "dave" });
    expect(() => rooms.signal("c1", { t: "rtc.signal", to: 0 })).not.toThrow();
    expect(rooms.signal("c1", { t: "rtc.signal", to: 1 })).toBe("c2");
  });
});

describe("RoomManager.snapshot", () => {
  it("describes a pre-game room with nullable game fields", () => {
    const rooms = manager();
    rooms.join("c2", { room: "r", role: "player", token: "bob@Bob" });
    rooms.join("c1", { room: "r", role: "player", token: "alice@Alice" });
    expect(rooms.snapshot("c1")).toEqual({
      t: "room.state",
      room: "r",
      players: [
        { slot: 0, name: "Bob" },
        { slot: 1, name: "Alice" },
      ],
      game: null,
      coreHash: null,
      romHash: null,
      dips: {},
      status: "waiting",
    });
  });
});
