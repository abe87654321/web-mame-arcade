import { describe, expect, it } from "vitest";
import { decodeInput, encodeInput } from "@wma/protocol";
import { gunzipInputLog } from "./input-log";
import { createRelay, type ClosedLog, type Outbound, type RelayOut } from "./relay";
import { TokenError, type TokenClaims, type TokenVerifier } from "./token";

const fakeVerifier: TokenVerifier = {
  verify(token: string): TokenClaims {
    if (token === "bad") throw new TokenError("nope");
    return { sub: token, exp: 9_999_999_999 };
  },
};

function relay() {
  return createRelay({ verifier: fakeVerifier });
}

function join(connectionId: string, token: string) {
  return { t: "room.join", room: "r", role: "player", token };
}

function byConnection(out: Outbound[]): Record<string, Outbound> {
  return Object.fromEntries(out.map((o) => [o.connectionId, o]));
}

describe("createRelay", () => {
  it("rejects a message that is not a known client type", () => {
    const out = relay().handle("c1", { t: "nope" });
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toMatchObject({ t: "error", code: "bad_message" });
  });

  it("rejects an invalid token without seating the connection", () => {
    const r = relay();
    const out = r.handle("c1", join("c1", "bad"));
    expect(out[0]?.message).toMatchObject({ t: "error", code: "invalid_token" });
    expect(r.handle("c1", { t: "rtc.signal", to: 0 })[0]?.message).toMatchObject({
      code: "not_joined",
    });
  });

  it("answers a join with a pre-game room.state", () => {
    const out = relay().handle("c1", join("c1", "alice"));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      connectionId: "c1",
      message: {
        t: "room.state",
        room: "r",
        self: 0,
        players: [{ slot: 0, name: "player", ready: false }],
        game: null,
        coreHash: null,
        romHash: null,
        dips: {},
        status: "waiting",
      },
    });
  });

  it("broadcasts the updated room.state when a second player joins", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    const out = byConnection(r.handle("c2", join("c2", "bob")));
    expect(Object.keys(out).sort()).toEqual(["c1", "c2"]);
    expect(out.c1?.message).toMatchObject({
      t: "room.state",
      self: 0,
      players: [
        { slot: 0, name: "player", ready: false },
        { slot: 1, name: "player", ready: false },
      ],
    });
    expect(out.c2?.message).toMatchObject({ t: "room.state", self: 1 });
  });

  it("routes rtc.signal only to the target slot, stamped with the sender", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    const out = r.handle("c1", { t: "rtc.signal", to: 1, sdp: { type: "offer" } });
    expect(out).toEqual([
      {
        connectionId: "c2",
        message: { t: "rtc.signal", from: 0, to: 1, sdp: { type: "offer" } },
      },
    ]);
  });

  it("overwrites a client-supplied from with the authoritative sender slot", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    const out = r.handle("c2", {
      t: "rtc.signal",
      from: 0,
      to: 0,
      sdp: { type: "answer" },
    });
    expect(out).toEqual([
      {
        connectionId: "c1",
        message: { t: "rtc.signal", from: 1, to: 0, sdp: { type: "answer" } },
      },
    ]);
  });

  it("reports an unknown target slot", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    const out = r.handle("c1", { t: "rtc.signal", to: 3 });
    expect(out[0]?.message).toMatchObject({ t: "error", code: "unknown_peer" });
  });

  it("rejects joining a second room on the same connection", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    const out = r.handle("c1", {
      t: "room.join",
      room: "other",
      role: "player",
      token: "alice",
    });
    expect(out[0]?.message).toMatchObject({ t: "error", code: "already_joined" });
  });

  it("broadcasts the host's game.start and flips status to playing", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));

    const out = r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });

    const starts = out.filter((o) => o.message.t === "game.start");
    expect(starts.map((o) => o.connectionId).sort()).toEqual(["c1", "c2"]);
    const states = out.filter((o) => o.message.t === "room.state");
    expect(states.map((o) => o.connectionId).sort()).toEqual(["c1", "c2"]);
    for (const state of states) {
      expect(state.message).toMatchObject({ t: "room.state", status: "playing" });
    }
  });

  it("rejects game.start from a non-host player", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    const out = r.handle("c2", { t: "game.start", startFrame: 0, inputDelay: 2 });
    expect(out[0]?.message).toMatchObject({ t: "error", code: "not_host" });
  });

  it("stamps and fans out player.ready, then re-broadcasts room.state", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));

    const out = r.handle("c1", { t: "player.ready", ready: true, player: 1 });

    const toggles = out.filter((o) => o.message.t === "player.ready");
    expect(toggles.map((o) => o.connectionId).sort()).toEqual(["c1", "c2"]);
    for (const toggle of toggles) {
      // The client-supplied player (1) is overwritten with the sender's slot (0).
      expect(toggle.message).toEqual({ t: "player.ready", ready: true, player: 0 });
    }
    const states = out.filter((o) => o.message.t === "room.state");
    expect(states.map((o) => o.connectionId).sort()).toEqual(["c1", "c2"]);
    expect(states[0]?.message).toMatchObject({
      t: "room.state",
      players: [
        { slot: 0, ready: true },
        { slot: 1, ready: false },
      ],
    });
  });

  it("rejects player.ready from a connection that never joined", () => {
    const out = relay().handle("c1", { t: "player.ready", ready: true });
    expect(out[0]?.message).toMatchObject({ t: "error", code: "not_joined" });
  });

  it("broadcasts a desync when two players report different hashes for a frame", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });

    // The first hash has nothing to compare against: no desync.
    expect(r.handle("c1", { t: "hash", frame: 60, crc32: 0xaaaa })).toEqual([]);

    const out = byConnection(r.handle("c2", { t: "hash", frame: 60, crc32: 0xbbbb }));
    expect(Object.keys(out).sort()).toEqual(["c1", "c2"]);
    for (const entry of Object.values(out)) {
      expect(entry.message).toEqual({ t: "desync", frame: 60 });
    }
  });

  it("does not broadcast when both players agree", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });

    r.handle("c1", { t: "hash", frame: 60, crc32: 0xaaaa });
    expect(r.handle("c2", { t: "hash", frame: 60, crc32: 0xaaaa })).toEqual([]);
  });

  it("rejects hash before the game starts", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    const out = r.handle("c1", { t: "hash", frame: 60, crc32: 0 });
    expect(out[0]?.message).toMatchObject({ t: "error", code: "not_playing" });
  });

  it("logs a detected desync", () => {
    const logged: { event: string; fields: Record<string, unknown> }[] = [];
    const r = createRelay({
      verifier: fakeVerifier,
      log: (event, fields) => logged.push({ event, fields }),
    });
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });
    r.handle("c1", { t: "hash", frame: 60, crc32: 0xaaaa });
    r.handle("c2", { t: "hash", frame: 60, crc32: 0xbbbb });

    expect(logged).toEqual([{ event: "desync", fields: { room: "r", frame: 60 } }]);
  });

  it("fans the host's state.snapshot to every other member", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    r.handle("c3", join("c3", "carol"));
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });

    const out = byConnection(
      r.handle("c1", {
        t: "state.snapshot",
        frame: 60,
        blobUrl: "http://relay/rooms/r/snapshot/1",
      }),
    );
    expect(Object.keys(out).sort()).toEqual(["c2", "c3"]);
    expect(out.c2?.message).toEqual({
      t: "state.snapshot",
      frame: 60,
      blobUrl: "http://relay/rooms/r/snapshot/1",
    });
  });

  it("rejects state.snapshot from a non-host", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });
    const out = r.handle("c2", {
      t: "state.snapshot",
      frame: 60,
      blobUrl: "http://relay/rooms/r/snapshot/1",
    });
    expect(out[0]?.message).toMatchObject({ t: "error", code: "not_host" });
  });

  it("marks T22-unowned client types as unsupported", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    const out = r.handle("c1", { t: "chat", text: "hi" });
    expect(out[0]?.message).toMatchObject({ t: "error", code: "unsupported" });
  });

  it("broadcasts the room without a leaver on disconnect", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    const out = byConnection(r.leave("c2"));
    expect(Object.keys(out)).toEqual(["c1"]);
    expect(out.c1?.message).toMatchObject({
      t: "room.state",
      players: [{ slot: 0, name: "player", ready: false }],
    });
  });

  it("ignores leave for an unknown connection", () => {
    expect(relay().leave("ghost")).toEqual([]);
  });
});

const gameSet = {
  t: "game.set" as const,
  driver: "gridlee",
  coreHash: "a".repeat(64),
  mameCommit: "b".repeat(40),
  romHash: "c".repeat(64),
  dips: { Difficulty: "Medium" },
};

describe("createRelay (input log, T30)", () => {
  it("stores the host's game.set and reflects it in room.state", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));

    const out = r.handle("c1", gameSet);
    const sets = out.filter((o) => o.message.t === "game.set");
    expect(sets.map((o) => o.connectionId).sort()).toEqual(["c1", "c2"]);
    const states = out.filter((o) => o.message.t === "room.state");
    expect(states.map((o) => o.connectionId).sort()).toEqual(["c1", "c2"]);
    for (const state of states) {
      expect(state.message).toMatchObject({
        t: "room.state",
        game: "gridlee",
        coreHash: "a".repeat(64),
        romHash: "c".repeat(64),
        dips: { Difficulty: "Medium" },
      });
    }
  });

  it("rejects game.set from a non-host", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    const out = r.handle("c2", gameSet);
    expect(out[0]?.message).toMatchObject({ t: "error", code: "not_host" });
  });

  it("records input frames and closes the log on the host's game.end", () => {
    const logs: ClosedLog[] = [];
    const r = createRelay({ verifier: fakeVerifier, onLogClosed: (log) => logs.push(log) });
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    r.handle("c1", gameSet);
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });

    // frame 2: P1 mask 1, P2 mask 0x10; frame 3: P1 mask 4.
    r.input("c1", encodeInput({ version: 1, player: 0, ackFrame: 0, firstFrame: 2, inputs: [1, 4] }));
    r.input("c2", encodeInput({ version: 1, player: 1, ackFrame: 0, firstFrame: 2, inputs: [0x10, 0] }));

    const out = r.handle("c1", { t: "game.end", frame: 3 });
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.room).toBe("r");
    expect(log.driver).toBe("gridlee");
    expect(log.mameCommit).toBe("b".repeat(40));
    expect(log.replayKey).toMatch(/^match\/r\/.+\.json\.gz$/);

    const decoded = gunzipInputLog(log.bytes);
    expect(decoded.frames).toEqual([
      [0, 0],
      [0, 0],
      [1, 0x10],
      [4, 0],
    ]);
    expect(decoded.end).toEqual({ frame: 3, scores: [] });

    // The room flips to ended for everyone.
    const states = out.filter((o) => o.message.t === "room.state");
    expect(states.map((o) => o.connectionId).sort()).toEqual(["c1", "c2"]);
    for (const state of states) {
      expect(state.message).toMatchObject({ t: "room.state", status: "ended" });
    }
  });

  it("rejects game.end from a non-host or a non-playing room", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    expect(r.handle("c1", { t: "game.end", frame: 0 })[0]?.message).toMatchObject({
      t: "error",
      code: "not_playing",
    });
    r.handle("c1", gameSet);
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });
    expect(r.handle("c2", { t: "game.end", frame: 0 })[0]?.message).toMatchObject({
      t: "error",
      code: "not_host",
    });
  });

  it("ignores binary input before the log is open", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    const bytes = encodeInput({ version: 1, player: 0, ackFrame: 0, firstFrame: 0, inputs: [1] });
    expect(r.input("c1", bytes)).toEqual([]);
  });

  it("records under the authenticated slot, not the packet's claimed player", () => {
    const logs: ClosedLog[] = [];
    const r = createRelay({ verifier: fakeVerifier, onLogClosed: (log) => logs.push(log) });
    r.handle("c1", join("c1", "alice")); // slot 0
    r.handle("c2", join("c2", "bob")); // slot 1
    r.handle("c1", gameSet);
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });

    // c1 (slot 0) forges a packet claiming to be player 1: dropped.
    r.input("c1", encodeInput({ version: 1, player: 1, ackFrame: 0, firstFrame: 2, inputs: [0x10, 0] }));
    // c2's genuine slot-1 packet is recorded.
    r.input("c2", encodeInput({ version: 1, player: 1, ackFrame: 0, firstFrame: 2, inputs: [0x20, 0] }));

    r.handle("c1", { t: "game.end", frame: 2 });
    const decoded = gunzipInputLog(logs[0]!.bytes);
    expect(decoded.frames).toEqual([
      [0, 0],
      [0, 0],
      [0, 0x20],
    ]);
  });

  it("opens no log when the host never sent game.set", () => {
    const logs: ClosedLog[] = [];
    const r = createRelay({ verifier: fakeVerifier, onLogClosed: (log) => logs.push(log) });
    r.handle("c1", join("c1", "alice"));
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 0 });
    r.input("c1", encodeInput({ version: 1, player: 0, ackFrame: 0, firstFrame: 0, inputs: [1] }));
    const out = r.handle("c1", { t: "game.end", frame: 0 });

    expect(logs).toEqual([]);
    expect(out[0]?.message).toMatchObject({ t: "room.state", status: "ended" });
  });

  it("rejects game.set once the match has started", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c1", gameSet);
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 0 });
    const out = r.handle("c1", gameSet);
    expect(out[0]?.message).toMatchObject({ t: "error", code: "already_started" });
  });

  it("does not fan game.end out to peers", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    r.handle("c1", gameSet);
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 0 });
    const out = r.handle("c1", { t: "game.end", frame: 0 });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((o) => o.message.t === "room.state")).toBe(true);
  });
});

describe("createRelay (viewer fan-out, T31)", () => {
  const isBinary = (
    out: RelayOut,
  ): out is { connectionId: string; binary: Uint8Array } => "binary" in out;
  const viewerJoin = (token: string) =>
    ({ t: "room.join", room: "r", role: "viewer", token }) as const;

  function playing(players = 2) {
    const r = relay();
    for (let i = 1; i <= players; i++) r.handle(`c${i}`, join(`c${i}`, `p${i}`));
    r.handle("c1", gameSet);
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });
    return r;
  }

  it("fans a player's input to the other members, not the sender", () => {
    const r = playing();
    const bytes = encodeInput({
      version: 1,
      player: 0,
      ackFrame: 0,
      firstFrame: 2,
      inputs: [1, 4],
    });
    const out = r.input("c1", bytes);
    expect(out).toEqual([{ connectionId: "c2", binary: bytes }]);
  });

  it("fans a player's input to viewers and never echoes a viewer's own packet", () => {
    const r = playing();
    r.handle("v1", viewerJoin("w1"));
    const bytes = encodeInput({
      version: 1,
      player: 0,
      ackFrame: 0,
      firstFrame: 2,
      inputs: [1],
    });
    const out = r.input("c1", bytes);
    expect(out.map((o) => o.connectionId).sort()).toEqual(["c2", "v1"]);
    expect(out.every(isBinary)).toBe(true);

    // A viewer is not a seated player: its binary frame is dropped, not fanned.
    expect(r.input("v1", bytes)).toEqual([]);
  });

  it("does not fan out a packet claiming another slot", () => {
    const r = playing();
    r.handle("v1", viewerJoin("w1"));
    // c1 is slot 0; a packet claiming slot 1 must reach neither peers nor viewers.
    const forged = encodeInput({
      version: 1,
      player: 1,
      ackFrame: 0,
      firstFrame: 2,
      inputs: [0x10, 0x20],
    });
    expect(r.input("c1", forged)).toEqual([]);
  });

  it("does not fan input out before the match starts", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    const bytes = encodeInput({
      version: 1,
      player: 0,
      ackFrame: 0,
      firstFrame: 0,
      inputs: [1],
    });
    expect(r.input("c1", bytes)).toEqual([]);
  });

  it("hands a mid-match viewer state plus catch-up from the start", () => {
    const r = playing();
    r.input(
      "c1",
      encodeInput({ version: 1, player: 0, ackFrame: 0, firstFrame: 2, inputs: [1, 4] }),
    );
    r.input(
      "c2",
      encodeInput({ version: 1, player: 1, ackFrame: 0, firstFrame: 2, inputs: [0x10, 0] }),
    );

    const out = r.handle("v1", viewerJoin("w1"));
    const byId = out.filter((o) => o.connectionId === "v1");
    const state = byId.find((o) => o.message.t === "viewer.state");
    expect(state?.message).toMatchObject({
      t: "viewer.state",
      room: "r",
      driver: "gridlee",
      coreHash: "a".repeat(64),
      mameCommit: "b".repeat(40),
      romHash: "c".repeat(64),
      startFrame: 0,
      inputDelay: 2,
      players: [
        { slot: 0, name: "player" },
        { slot: 1, name: "player" },
      ],
      snapshot: null,
    });

    const packets = (state?.frames ?? []).map((bytes) => decodeInput(bytes));
    expect(packets).toEqual([
      { version: 1, player: 0, ackFrame: 0, firstFrame: 0, inputs: [0, 0, 1, 4] },
      { version: 1, player: 1, ackFrame: 0, firstFrame: 0, inputs: [0, 0, 0x10, 0] },
    ]);
  });

  it("forwards viewer.snapshot to viewers only and includes it in viewer.state", () => {
    const r = playing();
    r.handle("v1", viewerJoin("w1"));
    r.handle("v2", viewerJoin("w2"));

    const snapshot = {
      t: "viewer.snapshot" as const,
      frame: 120,
      blobUrl: "http://relay/rooms/r/snapshot/1",
    };
    const out = r.handle("c1", snapshot);
    expect(out.map((o) => o.connectionId).sort()).toEqual(["v1", "v2"]);
    expect(out.every((o) => o.message.t === "viewer.snapshot")).toBe(true);

    const late = r.handle("v3", viewerJoin("w3")).find((o) => o.message.t === "viewer.state");
    expect(late?.message).toMatchObject({
      t: "viewer.state",
      snapshot: { frame: 120, blobUrl: "http://relay/rooms/r/snapshot/1" },
    });
  });

  it("gates viewer.snapshot on host and a playing room", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    const snapshot = {
      t: "viewer.snapshot" as const,
      frame: 1,
      blobUrl: "http://relay/snap",
    };
    expect(r.handle("c1", snapshot)[0]?.message).toMatchObject({
      t: "error",
      code: "not_playing",
    });
    r.handle("c1", gameSet);
    r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 0 });
    expect(r.handle("c2", snapshot)[0]?.message).toMatchObject({
      t: "error",
      code: "not_host",
    });
  });

  it("re-sends viewer.state to viewers on game.start", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("v1", viewerJoin("w1"));
    r.handle("c1", gameSet);
    const out = r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });
    const states = out.filter(
      (o) => o.connectionId === "v1" && o.message.t === "viewer.state",
    );
    expect(states).toHaveLength(1);
  });
});
