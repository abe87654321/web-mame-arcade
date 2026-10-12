import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PLAYER_SLOTS } from "./input";
import {
  INPUT_TYPE,
  clientMessage,
  parseMessage,
  safeParseMessage,
  serverMessage,
  type AnyMessage,
} from "./messages";

const hash64 = "a".repeat(64);

const validMessages: AnyMessage[] = [
  { t: "room.join", room: "r1", role: "player", token: "jwt" },
  {
    t: "room.state",
    room: "r1",
    self: 0,
    players: [{ slot: 0, name: "alice", ready: true }],
    game: "gridlee",
    coreHash: hash64,
    romHash: hash64,
    dips: { difficulty: "normal" },
    status: "playing",
  },
  {
    t: "room.state",
    room: "r1",
    self: null,
    players: [{ slot: 0, name: "alice", ready: false }],
    game: null,
    coreHash: null,
    romHash: null,
    dips: {},
    status: "waiting",
  },
  {
    t: "rtc.signal",
    to: 1,
    sdp: { type: "offer", sdp: "v=0" },
  },
  { t: "rtc.signal", to: 0, candidate: { candidate: "candidate:1", sdpMid: "0" } },
  { t: "player.ready", ready: true },
  { t: "player.ready", ready: false, player: 2 },
  // T29: a client toggles its own pause; the relay fans the aggregate value out
  // with the sender slot stamped.
  { t: "player.pause", paused: true },
  { t: "player.pause", paused: false, player: 1 },
  {
    t: "game.set",
    driver: "gridlee",
    coreHash: hash64,
    mameCommit: "b".repeat(40),
    romHash: hash64,
    dips: { difficulty: "normal" },
  },
  { t: "game.start", startFrame: 0, inputDelay: 2 },
  { t: "state.snapshot", frame: 120, blobUrl: "https://example.test/snap" },
  { t: "viewer.snapshot", frame: 120, blobUrl: "https://example.test/snap" },
  {
    t: "viewer.state",
    room: "r1",
    driver: "gridlee",
    coreHash: hash64,
    mameCommit: "b".repeat(40),
    romHash: hash64,
    dips: { difficulty: "normal" },
    startFrame: 0,
    inputDelay: 2,
    players: [{ slot: 0, name: "alice" }],
    snapshot: { frame: 120, blobUrl: "https://example.test/snap" },
    video: false,
  },
  {
    t: "viewer.state",
    room: "r1",
    driver: "gridlee",
    coreHash: hash64,
    mameCommit: "b".repeat(40),
    romHash: hash64,
    dips: {},
    startFrame: 0,
    inputDelay: 2,
    players: [{ slot: 0, name: "alice" }],
    snapshot: null,
    video: false,
  },
  { t: "video.set", enabled: true },
  { t: "video.set", enabled: false },
  {
    t: "livekit.access",
    url: "wss://livekit.example.test",
    room: "r1",
    token: "lk-jwt",
  },
  { t: "hash", frame: 60, crc32: 0xdeadbeef },
  { t: "desync", frame: 60 },
  { t: "score.live", player: 0, score: 12345, frame: 90 },
  { t: "game.end", frame: 300 },
  { t: "input.request", fromFrame: 120 },
  { t: "input.resync", fromFrame: 120 },
  { t: "chat", text: "gg" },
  { t: "error", code: "room_not_found", message: "no such room" },
];

describe("message schemas", () => {
  it("accepts every documented message type", () => {
    for (const message of validMessages) {
      const result = safeParseMessage(message);
      expect(result.success, `rejected ${message.t}`).toBe(true);
    }
  });

  it("round-trips through parseMessage unchanged", () => {
    for (const message of validMessages) {
      expect(parseMessage(message)).toEqual(message);
    }
  });

  it("rejects an unknown message type", () => {
    expect(safeParseMessage({ t: "nope" }).success).toBe(false);
  });

  it("rejects missing and extra fields (strict objects)", () => {
    expect(safeParseMessage({ t: "chat" }).success).toBe(false);
    expect(safeParseMessage({ t: "chat", text: "hi", extra: 1 }).success).toBe(
      false,
    );
    expect(
      safeParseMessage({ t: "game.start", startFrame: 0 }).success,
    ).toBe(false);
  });

  it("rejects wrong field types and out-of-range values", () => {
    expect(safeParseMessage({ t: "chat", text: 42 }).success).toBe(false);
    expect(safeParseMessage({ t: "hash", frame: -1, crc32: 0 }).success).toBe(
      false,
    );
    expect(
      safeParseMessage({ t: "game.start", startFrame: 0, inputDelay: 1.5 })
        .success,
    ).toBe(false);
    expect(
      safeParseMessage({ t: "score.live", player: PLAYER_SLOTS, score: 1, frame: 0 })
        .success,
    ).toBe(false);
    expect(
      safeParseMessage({
        t: "game.set",
        driver: "gridlee",
        coreHash: "not-a-hash",
        mameCommit: "b".repeat(40),
        romHash: hash64,
        dips: {},
      }).success,
    ).toBe(false);
    expect(
      safeParseMessage({
        t: "room.state",
        room: "r1",
        players: [],
        game: "gridlee",
        coreHash: "not-a-hash",
        romHash: hash64,
        dips: {},
        status: "playing",
      }).success,
    ).toBe(false);
  });

  it("tells a connection which player slot is its own", () => {
    const base = {
      t: "room.state",
      room: "r1",
      players: [{ slot: 0, name: "alice", ready: false }],
      game: null,
      coreHash: null,
      romHash: null,
      dips: {},
      status: "waiting",
    };
    expect(safeParseMessage({ ...base, self: 0 }).success).toBe(true);
    expect(safeParseMessage({ ...base, self: null }).success).toBe(true);
    expect(safeParseMessage(base).success).toBe(false);
  });

  it("requires a ready flag on every player and stamps player.ready", () => {
    expect(
      safeParseMessage({
        t: "room.state",
        room: "r1",
        self: 0,
        players: [{ slot: 0, name: "alice" }],
        game: null,
        coreHash: null,
        romHash: null,
        dips: {},
        status: "waiting",
      }).success,
    ).toBe(false);
    expect(safeParseMessage({ t: "player.ready", ready: "yes" }).success).toBe(false);
    expect(clientMessage.safeParse({ t: "player.ready", ready: true }).success).toBe(true);
    expect(
      serverMessage.safeParse({ t: "player.ready", ready: true, player: 1 }).success,
    ).toBe(true);
  });

  it("stamps the sender slot on the fanned-out player.pause", () => {
    // Client → relay carries only the toggle; the relay re-emits it with the
    // sender slot (T29, docs/contracts/ws-messages.md).
    expect(clientMessage.safeParse({ t: "player.pause", paused: true }).success).toBe(
      true,
    );
    expect(
      serverMessage.safeParse({ t: "player.pause", paused: true, player: 0 }).success,
    ).toBe(true);
    // strict: paused is required and boolean; a bad slot is rejected.
    expect(safeParseMessage({ t: "player.pause" }).success).toBe(false);
    expect(safeParseMessage({ t: "player.pause", paused: "yes" }).success).toBe(false);
    expect(
      safeParseMessage({ t: "player.pause", paused: true, player: PLAYER_SLOTS })
        .success,
    ).toBe(false);
  });

  it("carries the relay-stamped sender slot on forwarded rtc.signal", () => {
    const forwarded = {
      t: "rtc.signal",
      from: 0,
      to: 1,
      sdp: { type: "offer", sdp: "v=0" },
    };
    expect(safeParseMessage(forwarded).success).toBe(true);
    expect(serverMessage.safeParse(forwarded).success).toBe(true);
    expect(
      safeParseMessage({ t: "rtc.signal", from: PLAYER_SLOTS, to: 1 }).success,
    ).toBe(false);
  });

  it("keeps the binary input packet out of the JSON union", () => {
    expect(INPUT_TYPE).toBe("input");
    expect(safeParseMessage({ t: "input", player: 0 }).success).toBe(false);
  });

  it("routes each message to the directions in the contract table", () => {
    const byType = Object.fromEntries(validMessages.map((m) => [m.t, m]));
    const clientOnly = ["room.join", "hash", "game.end", "input.request"] as const;
    const serverOnly = [
      "room.state",
      "viewer.state",
      "desync",
      "input.resync",
      "error",
      "livekit.access",
    ] as const;
    const both = [
      "rtc.signal",
      "player.ready",
      "player.pause",
      "game.set",
      "game.start",
      "state.snapshot",
      "viewer.snapshot",
      "video.set",
      "score.live",
      "chat",
    ] as const;

    for (const t of clientOnly) {
      expect(clientMessage.safeParse(byType[t]).success, t).toBe(true);
      expect(serverMessage.safeParse(byType[t]).success, t).toBe(false);
    }
    for (const t of serverOnly) {
      expect(serverMessage.safeParse(byType[t]).success, t).toBe(true);
      expect(clientMessage.safeParse(byType[t]).success, t).toBe(false);
    }
    for (const t of both) {
      expect(clientMessage.safeParse(byType[t]).success, t).toBe(true);
      expect(serverMessage.safeParse(byType[t]).success, t).toBe(true);
    }
  });

  it("sends viewer.state only to viewers and viewer.snapshot both ways", () => {
    const state = {
      t: "viewer.state",
      room: "r1",
      driver: "gridlee",
      coreHash: hash64,
      mameCommit: "b".repeat(40),
      romHash: hash64,
      dips: {},
      startFrame: 0,
      inputDelay: 2,
      players: [{ slot: 0, name: "alice" }],
      snapshot: null,
      video: false,
    };
    expect(serverMessage.safeParse(state).success).toBe(true);
    expect(clientMessage.safeParse(state).success).toBe(false);
    // A viewer needs mameCommit (to pin the core) and a snapshot slot.
    expect(
      serverMessage.safeParse({ ...state, mameCommit: undefined }).success,
    ).toBe(false);
    expect(serverMessage.safeParse({ ...state, snapshot: undefined }).success).toBe(
      false,
    );
    expect(
      serverMessage.safeParse({
        ...state,
        players: [{ slot: PLAYER_SLOTS, name: "alice" }],
      }).success,
    ).toBe(false);
  });

  it("carries the host's A/V opt-in and per-recipient LiveKit credentials", () => {
    // video.set is host → relay → all; livekit.access is relay → client only.
    expect(clientMessage.safeParse({ t: "video.set", enabled: true }).success).toBe(
      true,
    );
    expect(serverMessage.safeParse({ t: "video.set", enabled: false }).success).toBe(
      true,
    );
    const access = {
      t: "livekit.access",
      url: "wss://livekit.example.test",
      room: "r1",
      token: "lk-jwt",
    };
    expect(serverMessage.safeParse(access).success).toBe(true);
    expect(clientMessage.safeParse(access).success).toBe(false);
    // viewer.state flags whether the host is sharing A/V.
    expect(
      serverMessage.safeParse({
        t: "viewer.state",
        room: "r1",
        driver: "gridlee",
        coreHash: hash64,
        mameCommit: "b".repeat(40),
        romHash: hash64,
        dips: {},
        startFrame: 0,
        inputDelay: 2,
        players: [],
        snapshot: null,
        video: true,
      }).success,
    ).toBe(true);
    // strict: video is required and boolean, credentials need a token.
    expect(
      serverMessage.safeParse({
        t: "viewer.state",
        room: "r1",
        driver: "gridlee",
        coreHash: hash64,
        mameCommit: "b".repeat(40),
        romHash: hash64,
        dips: {},
        startFrame: 0,
        inputDelay: 2,
        players: [],
        snapshot: null,
      }).success,
    ).toBe(false);
    expect(
      serverMessage.safeParse({ ...access, token: undefined }).success,
    ).toBe(false);
  });
});

describe("message fuzz", () => {
  const arbSlot = fc.integer({ min: 0, max: PLAYER_SLOTS - 1 });
  const arbFrame = fc.integer({ min: 0, max: 0xffffffff });
  const arbChat: fc.Arbitrary<AnyMessage> = fc.record({
    t: fc.constant("chat" as const),
    text: fc.string(),
  });
  const arbHash: fc.Arbitrary<AnyMessage> = fc.record({
    t: fc.constant("hash" as const),
    frame: arbFrame,
    crc32: fc.integer({ min: 0, max: 0xffffffff }),
  });
  const arbScore: fc.Arbitrary<AnyMessage> = fc.record({
    t: fc.constant("score.live" as const),
    player: arbSlot,
    score: fc.integer({ min: -1000, max: 1_000_000 }),
    frame: arbFrame,
  });
  const arbDesync: fc.Arbitrary<AnyMessage> = fc.record({
    t: fc.constant("desync" as const),
    frame: arbFrame,
  });
  const arbGameStart: fc.Arbitrary<AnyMessage> = fc.record({
    t: fc.constant("game.start" as const),
    startFrame: arbFrame,
    inputDelay: fc.integer({ min: 0, max: 30 }),
  });

  it("accepts arbitrary well-formed messages", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          arbChat,
          arbHash,
          arbScore,
          arbDesync,
          arbGameStart,
        ),
        (message) => {
          expect(safeParseMessage(message).success).toBe(true);
          expect(parseMessage(message)).toEqual(message);
        },
      ),
      { numRuns: 500, seed: 2 },
    );
  });
});
