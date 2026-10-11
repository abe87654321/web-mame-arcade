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
    expect(rooms.snapshot("c2").players).toEqual([{ slot: 0, name: "player", ready: false }]);
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
    try {
      rooms.join("v2", { room: "r", role: "player", token: "watcher" });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("room_full");
    }
    expect(rooms.roomIdOf("v1")).toBe("r");
    expect(rooms.broadcastTargets("r")).toHaveLength(PLAYER_SLOTS + 1);
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

  it("routes to the connection seated in the target slot with the sender slot", () => {
    expect(seated().signal("c1", { t: "rtc.signal", to: 1 })).toEqual({
      target: "c2",
      from: 0,
    });
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

  it("rejects a slot-less viewer as a signal sender", () => {
    try {
      seated().signal("c9", { t: "rtc.signal", to: 0 });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_joined");
    }
  });

  it("keeps rooms isolated", () => {
    const rooms = seated();
    rooms.join("x1", { room: "other", role: "player", token: "dave" });
    expect(() => rooms.signal("c1", { t: "rtc.signal", to: 0 })).not.toThrow();
    expect(rooms.signal("c1", { t: "rtc.signal", to: 1 })).toEqual({
      target: "c2",
      from: 0,
    });
  });
});

describe("RoomManager.begin", () => {
  function twoPlayers() {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "player", token: "alice" });
    rooms.join("c2", { room: "r", role: "player", token: "bob" });
    return rooms;
  }

  it("records the host's start and flips the room to playing", () => {
    const rooms = twoPlayers();
    const result = rooms.begin("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });
    expect(result).toEqual({ roomId: "r", from: 0 });
    expect(rooms.snapshot("c2").status).toBe("playing");
  });

  it("lets the lowest occupied slot start even when it is not slot 0", () => {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "viewer", token: "watcher" });
    rooms.join("c2", { room: "r", role: "player", token: "bob" });
    expect(rooms.begin("c2", { t: "game.start", startFrame: 0, inputDelay: 2 }).from).toBe(0);
  });

  it("rejects a non-host player", () => {
    const rooms = twoPlayers();
    try {
      rooms.begin("c2", { t: "game.start", startFrame: 0, inputDelay: 2 });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_host");
    }
  });

  it("rejects a slot-less viewer", () => {
    const rooms = twoPlayers();
    rooms.join("c9", { room: "r", role: "viewer", token: "watcher" });
    try {
      rooms.begin("c9", { t: "game.start", startFrame: 0, inputDelay: 2 });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_joined");
    }
  });

  it("rejects an unjoined connection", () => {
    try {
      twoPlayers().begin("ghost", { t: "game.start", startFrame: 0, inputDelay: 2 });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_joined");
    }
  });

  it("rejects a second start", () => {
    const rooms = twoPlayers();
    rooms.begin("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });
    try {
      rooms.begin("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("already_started");
    }
  });
});

describe("RoomManager.setReady", () => {
  function seated() {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "player", token: "alice" });
    rooms.join("c2", { room: "r", role: "player", token: "bob" });
    return rooms;
  }

  it("records a player's ready flag in the room snapshot", () => {
    const rooms = seated();
    expect(rooms.setReady("c1", { t: "player.ready", ready: true })).toEqual({
      roomId: "r",
      from: 0,
    });
    expect(rooms.snapshot("c2").players).toEqual([
      { slot: 0, name: "player", ready: true },
      { slot: 1, name: "player", ready: false },
    ]);
  });

  it("ignores a client-supplied player slot (relay-authoritative)", () => {
    const rooms = seated();
    rooms.setReady("c1", { t: "player.ready", ready: true, player: 1 });
    expect(rooms.snapshot("c1").players[0]).toEqual({
      slot: 0,
      name: "player",
      ready: true,
    });
  });

  it("allows toggling back to not ready", () => {
    const rooms = seated();
    rooms.setReady("c1", { t: "player.ready", ready: true });
    rooms.setReady("c1", { t: "player.ready", ready: false });
    expect(rooms.snapshot("c1").players[0]?.ready).toBe(false);
  });

  it("rejects a slot-less viewer", () => {
    const rooms = seated();
    rooms.join("c9", { room: "r", role: "viewer", token: "watcher" });
    try {
      rooms.setReady("c9", { t: "player.ready", ready: true });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_joined");
    }
  });

  it("rejects an unjoined connection", () => {
    try {
      seated().setReady("ghost", { t: "player.ready", ready: true });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_joined");
    }
  });
});

describe("RoomManager.recordHash", () => {
  function playing() {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "player", token: "alice" });
    rooms.join("c2", { room: "r", role: "player", token: "bob" });
    rooms.begin("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });
    return rooms;
  }

  it("reports no mismatch for two slots agreeing on a frame", () => {
    const rooms = playing();
    expect(rooms.recordHash("c1", { t: "hash", frame: 60, crc32: 0xabcd })).toEqual({
      roomId: "r",
      slot: 0,
      frame: 60,
      mismatch: false,
    });
    expect(rooms.recordHash("c2", { t: "hash", frame: 60, crc32: 0xabcd }).mismatch).toBe(
      false,
    );
  });

  it("reports a mismatch when two slots disagree on a frame", () => {
    const rooms = playing();
    rooms.recordHash("c1", { t: "hash", frame: 60, crc32: 0xabcd });
    expect(rooms.recordHash("c2", { t: "hash", frame: 60, crc32: 0x1234 }).mismatch).toBe(
      true,
    );
  });

  it("ignores a repeated hash for the same slot and frame (first wins)", () => {
    const rooms = playing();
    rooms.recordHash("c1", { t: "hash", frame: 60, crc32: 0xabcd });
    expect(rooms.recordHash("c1", { t: "hash", frame: 60, crc32: 0x9999 }).mismatch).toBe(
      false,
    );
    // The first value is authoritative, so c2 agreeing with it is no mismatch.
    expect(rooms.recordHash("c2", { t: "hash", frame: 60, crc32: 0xabcd }).mismatch).toBe(
      false,
    );
  });

  it("compares only the latest frame", () => {
    const rooms = playing();
    rooms.recordHash("c1", { t: "hash", frame: 60, crc32: 0xabcd });
    rooms.recordHash("c2", { t: "hash", frame: 60, crc32: 0x1234 });
    // Both move on to frame 120 with the same value: fresh comparison, no mismatch.
    rooms.recordHash("c1", { t: "hash", frame: 120, crc32: 0xaa });
    expect(rooms.recordHash("c2", { t: "hash", frame: 120, crc32: 0xaa }).mismatch).toBe(
      false,
    );
    // Stale frame 60 is ignored.
    expect(rooms.recordHash("c2", { t: "hash", frame: 60, crc32: 0x1234 }).mismatch).toBe(
      false,
    );
  });

  it("ignores an absurd frame jump that would strand the comparison", () => {
    const rooms = playing();
    // The very first hash is absurd: it must not move the comparison frame and
    // disable detection for the rest of the match.
    expect(
      rooms.recordHash("c1", { t: "hash", frame: 0xffffffff, crc32: 0 }).mismatch,
    ).toBe(false);
    // The genuine frame 60 comparison still works.
    rooms.recordHash("c1", { t: "hash", frame: 60, crc32: 0xabcd });
    expect(rooms.recordHash("c2", { t: "hash", frame: 60, crc32: 0x1234 }).mismatch).toBe(
      true,
    );
  });

  it("rejects a slot-less viewer", () => {
    const rooms = playing();
    rooms.join("c9", { room: "r", role: "viewer", token: "watcher" });
    try {
      rooms.recordHash("c9", { t: "hash", frame: 60, crc32: 0 });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_joined");
    }
  });

  it("rejects an unjoined connection", () => {
    try {
      playing().recordHash("ghost", { t: "hash", frame: 60, crc32: 0 });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_joined");
    }
  });

  it("rejects a hash before the game starts", () => {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "player", token: "alice" });
    try {
      rooms.recordHash("c1", { t: "hash", frame: 60, crc32: 0 });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_playing");
    }
  });
});

describe("RoomManager.snapshotForResync", () => {
  function playing() {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "player", token: "alice" });
    rooms.join("c2", { room: "r", role: "player", token: "bob" });
    rooms.begin("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });
    return rooms;
  }

  it("accepts the host's snapshot", () => {
    expect(playing().snapshotForResync("c1")).toEqual({ roomId: "r", from: 0 });
  });

  it("rejects a non-host player", () => {
    try {
      playing().snapshotForResync("c2");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_host");
    }
  });

  it("rejects a slot-less viewer", () => {
    const rooms = playing();
    rooms.join("c9", { room: "r", role: "viewer", token: "watcher" });
    try {
      rooms.snapshotForResync("c9");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_joined");
    }
  });

  it("rejects a snapshot before the game starts", () => {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "player", token: "alice" });
    try {
      rooms.snapshotForResync("c1");
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_playing");
    }
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
      self: 1,
      players: [
        { slot: 0, name: "Bob", ready: false },
        { slot: 1, name: "Alice", ready: false },
      ],
      game: null,
      coreHash: null,
      romHash: null,
      dips: {},
      status: "waiting",
    });
  });

  it("reports a null self slot for a viewer", () => {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "player", token: "alice" });
    rooms.join("c9", { room: "r", role: "viewer", token: "watcher" });
    expect(rooms.snapshot("c9").self).toBeNull();
    expect(rooms.snapshot("c1").self).toBe(0);
  });
});

describe("RoomManager A/V (T41)", () => {
  function playing() {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "player", token: "alice@Alice" });
    rooms.join("c2", { room: "r", role: "player", token: "bob@Bob" });
    rooms.join("v1", { room: "r", role: "viewer", token: "watcher" });
    rooms.setGame("c1", {
      t: "game.set",
      driver: "gridlee",
      coreHash: "a".repeat(64),
      mameCommit: "b".repeat(40),
      romHash: "c".repeat(64),
      dips: {},
    });
    rooms.begin("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });
    return rooms;
  }

  it("lets only the host toggle A/V in a playing room", () => {
    const rooms = playing();
    expect(rooms.setVideo("c1", true)).toEqual({ roomId: "r", from: 0 });
    expect(rooms.videoEnabled("r")).toBe(true);
    expect(rooms.setVideo("c1", false)).toEqual({ roomId: "r", from: 0 });
    expect(rooms.videoEnabled("r")).toBe(false);

    try {
      rooms.setVideo("c2", true);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_host");
    }
    try {
      rooms.setVideo("v1", true);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_joined");
    }
  });

  it("rejects A/V before the match starts", () => {
    const rooms = manager();
    rooms.join("c1", { room: "r", role: "player", token: "alice" });
    try {
      rooms.setVideo("c1", true);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as RelayError).code).toBe("not_playing");
    }
  });

  it("flags video in the viewer handshake and clears it per match", () => {
    const rooms = playing();
    rooms.setVideo("c1", true);
    expect(rooms.viewerState("v1")?.video).toBe(true);
    // A new match starts with A/V off.
    rooms.end("c1", { t: "game.end", frame: 10 });
    rooms.begin("c1", { t: "game.start", startFrame: 20, inputDelay: 2 });
    expect(rooms.videoEnabled("r")).toBe(false);
    expect(rooms.viewerState("v1")?.video).toBe(false);
  });

  it("grants the host publish and every other member subscribe-only", () => {
    const rooms = playing();
    expect(rooms.livekitGrants("r")).toEqual([
      { connectionId: "c1", identity: "alice", name: "Alice", canPublish: true },
      { connectionId: "c2", identity: "bob", name: "Bob", canPublish: false },
      { connectionId: "v1", identity: "watcher", name: "player", canPublish: false },
    ]);
    expect(rooms.livekitGrant("v1")).toEqual({
      connectionId: "v1",
      identity: "watcher",
      name: "player",
      canPublish: false,
    });
    expect(rooms.livekitGrant("ghost")).toBeNull();
  });
});
