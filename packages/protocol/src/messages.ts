/**
 * Relay WebSocket message schemas, single source of truth for
 * docs/contracts/ws-messages.md. Every JSON message is `{ t, ...fields }`.
 *
 * `input` is binary and is NOT a JSON message: encode/decode it with
 * `encodeInput`/`decodeInput` and tag it with {@link INPUT_TYPE}.
 *
 * Pinned by the contract (T22/T23): room.state players/dips/status plus the
 * recipient's own `self` slot, and rtc.signal with its relay-stamped `from`
 * (sdp/candidate stay opaque).
 */
import { z } from "zod";
import { PLAYER_SLOTS } from "./input.ts";

/** The one binary message type; everything else is JSON. */
export const INPUT_TYPE = "input";

const slot = z.number().int().min(0).max(PLAYER_SLOTS - 1);
const frame = z.number().int().min(0).max(0xffffffff);
const hash = z.string().regex(/^[0-9a-f]{64}$/, "lowercase sha256 hex");

const sessionDescription = z.strictObject({
  type: z.enum(["offer", "answer", "pranswer", "rollback"]),
  sdp: z.string().optional(),
});

const iceCandidate = z.strictObject({
  candidate: z.string(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});

export const roomJoin = z.strictObject({
  t: z.literal("room.join"),
  room: z.string().min(1),
  role: z.enum(["player", "viewer"]),
  token: z.string().min(1),
});

export const roomState = z.strictObject({
  t: z.literal("room.state"),
  room: z.string().min(1),
  // The recipient's own slot (null for viewers), so a client can pick its
  // role in a pair's negotiation; every member gets a personal snapshot.
  self: slot.nullable(),
  players: z.array(z.strictObject({ slot, name: z.string(), ready: z.boolean() })),
  // Null until the host sets a game/DIPs; `dips` is `{}` and status `waiting`
  // pre-game (docs/contracts/ws-messages.md).
  game: z.string().min(1).nullable(),
  coreHash: hash.nullable(),
  romHash: hash.nullable(),
  dips: z.record(z.string(), z.union([z.string(), z.number()])),
  status: z.enum(["waiting", "playing", "ended"]),
});

export const rtcSignal = z.strictObject({
  t: z.literal("rtc.signal"),
  // Sender slot, stamped by the relay on the forwarded message. Optional on the
  // client→relay direction; the relay always overwrites it (docs/03, T23).
  from: slot.optional(),
  to: slot,
  sdp: sessionDescription.optional(),
  candidate: iceCandidate.optional(),
});

export const playerReady = z.strictObject({
  t: z.literal("player.ready"),
  ready: z.boolean(),
  // Sender slot, stamped by the relay on the forwarded message; ignored on the
  // client→relay direction (docs/contracts/ws-messages.md, T27).
  player: slot.optional(),
});

/**
 * Collaborative pause (T29). A seated player sends its own toggle; the relay
 * aggregates the room's paused slots and fans out one `paused` boolean (so a
 * single player resuming cannot unpause a peer that is still hidden) with the
 * sender slot stamped, exactly like `player.ready` (T27).
 */
export const playerPause = z.strictObject({
  t: z.literal("player.pause"),
  paused: z.boolean(),
  // Sender slot, stamped by the relay on the fanned-out message; ignored on the
  // client→relay direction (docs/contracts/ws-messages.md, T29).
  player: slot.optional(),
});

export const gameSet = z.strictObject({
  t: z.literal("game.set"),
  driver: z.string().min(1),
  // core_hash / rom_hash: lowercase sha256 hex (contracts/core-version.md).
  coreHash: hash,
  // mame/ commit the core was built from; the verifier rebuilds from it.
  mameCommit: z.string().regex(/^[0-9a-f]{40}$/, "lowercase 40-hex commit"),
  romHash: hash,
  dips: z.record(z.string(), z.union([z.string(), z.number()])),
});

export const gameStart = z.strictObject({
  t: z.literal("game.start"),
  startFrame: frame,
  inputDelay: z.number().int().min(0),
});

export const stateSnapshot = z.strictObject({
  t: z.literal("state.snapshot"),
  frame,
  blobUrl: z.string().min(1),
});

/**
 * The host's periodic live-join snapshot (T31): unlike `state.snapshot` it is
 * not a resync, so the relay stores it and forwards it to viewers only. A
 * joining viewer loads it and replays the recorded inputs since `frame`.
 */
export const viewerSnapshot = z.strictObject({
  t: z.literal("viewer.snapshot"),
  frame,
  blobUrl: z.string().min(1),
});

/**
 * The viewer's join handshake (T31/T41): the match identity (incl.
 * `mameCommit`, absent from `room.state`), the start frame/delay, the seated
 * roster, the latest live-join snapshot (null until the host has produced one)
 * and whether the host is sharing LiveKit A/V (T41; the join credentials
 * follow as a separate per-recipient `livekit.access`).
 */
export const viewerState = z.strictObject({
  t: z.literal("viewer.state"),
  room: z.string().min(1),
  driver: z.string().min(1),
  coreHash: hash,
  mameCommit: z.string().regex(/^[0-9a-f]{40}$/, "lowercase 40-hex commit"),
  romHash: hash,
  dips: z.record(z.string(), z.union([z.string(), z.number()])),
  startFrame: frame,
  inputDelay: z.number().int().min(0),
  players: z.array(z.strictObject({ slot, name: z.string() })),
  snapshot: z
    .strictObject({ frame, blobUrl: z.string().min(1) })
    .nullable(),
  // Whether the host is currently sharing A/V via LiveKit (T41).
  video: z.boolean(),
});

/**
 * Host opt-in for the LiveKit A/V fallback (T41). Sent host → relay; the relay
 * records it on the room, fans it out to every member and, when enabled,
 * follows up with a per-recipient `livekit.access`. Sent relay → all so the
 * lobby/viewer can reflect the host's choice.
 */
export const videoSet = z.strictObject({
  t: z.literal("video.set"),
  enabled: z.boolean(),
});

/**
 * A recipient's LiveKit join credentials (T41), relay → client only. Issued
 * per member (`identity` = the join token's `sub`); the host grants publish,
 * viewers subscribe only. `room` is the LiveKit room name (= arcade room id).
 */
export const livekitAccess = z.strictObject({
  t: z.literal("livekit.access"),
  url: z.string().min(1),
  room: z.string().min(1),
  token: z.string().min(1),
});

export const hashMessage = z.strictObject({
  t: z.literal("hash"),
  frame,
  crc32: z.number().int().min(0).max(0xffffffff),
});

export const desync = z.strictObject({
  t: z.literal("desync"),
  frame,
});

/**
 * A seated player's live score (T32); display only. The relay stamps the
 * sender's own slot on the fanned-out message and ignores any client-supplied
 * `player`, exactly like `player.ready` (T27), so a client cannot forge another
 * slot's score. Sent player → relay → all.
 */
export const scoreLive = z.strictObject({
  t: z.literal("score.live"),
  // Sender slot, stamped by the relay on the fanned-out message; ignored on the
  // client→relay direction (docs/contracts/ws-messages.md, T32).
  player: slot.optional(),
  score: z.number().int().min(0),
  frame,
});

export const gameEnd = z.strictObject({
  t: z.literal("game.end"),
  frame,
});

/**
 * A stalled player asks the relay to resend the recorded inputs from
 * `fromFrame` (T31 stall recovery): the relay replies with `input.resync`
 * plus the log's frames as binary, so a peer that fell behind the 8-frame
 * redundancy window can catch up instead of waiting forever.
 */
export const inputRequest = z.strictObject({
  t: z.literal("input.request"),
  fromFrame: frame,
});

/** Reply to `input.request`; the catch-up frames follow as binary messages. */
export const inputResync = z.strictObject({
  t: z.literal("input.resync"),
  fromFrame: frame,
});

export const chat = z.strictObject({
  t: z.literal("chat"),
  text: z.string(),
});

export const errorMessage = z.strictObject({
  t: z.literal("error"),
  code: z.string().min(1),
  message: z.string(),
});

const jsonSchemas = [
  roomJoin,
  roomState,
  rtcSignal,
  playerReady,
  playerPause,
  gameSet,
  gameStart,
  stateSnapshot,
  viewerSnapshot,
  viewerState,
  videoSet,
  livekitAccess,
  hashMessage,
  desync,
  scoreLive,
  gameEnd,
  inputRequest,
  inputResync,
  chat,
  errorMessage,
] as const;

/** Discriminated union of every JSON message, keyed on `t`. */
export const anyMessage = z.discriminatedUnion("t", jsonSchemas);

/** Messages a client may send to the relay (JSON subset). */
export const clientMessage = z.discriminatedUnion("t", [
  roomJoin,
  rtcSignal,
  playerReady,
  playerPause,
  gameSet,
  gameStart,
  stateSnapshot,
  // A host publishes the live-join snapshot; the relay stores it and forwards
  // it to viewers only (T31).
  viewerSnapshot,
  // The host toggles the LiveKit A/V fallback on/off (T41).
  videoSet,
  hashMessage,
  scoreLive,
  gameEnd,
  inputRequest,
  chat,
]);

/** Messages the relay may send to a client (JSON subset). */
export const serverMessage = z.discriminatedUnion("t", [
  roomState,
  rtcSignal,
  // The relay stamps the sender's slot and fans a toggled ready flag out to the
  // room, then re-broadcasts room.state (T27).
  playerReady,
  playerPause,
  // The relay fans the host's game.set out to every member and reflects it in
  // room.state (T30, docs/contracts/ws-messages.md).
  gameSet,
  // The relay fans the host's start out to every member so each peer agrees on
  // startFrame/inputDelay before stepping (T24, docs/03).
  gameStart,
  stateSnapshot,
  // The host's live-join snapshot is forwarded to viewers only (T31).
  viewerSnapshot,
  // The relay sends a joining viewer the match identity + latest snapshot (T31).
  viewerState,
  // The relay fans the host's A/V toggle out to every member and, when enabled,
  // sends each recipient its own LiveKit join credentials (T41).
  videoSet,
  livekitAccess,
  desync,
  scoreLive,
  inputResync,
  chat,
  errorMessage,
]);

export type RoomJoin = z.infer<typeof roomJoin>;
export type RoomState = z.infer<typeof roomState>;
export type RtcSignal = z.infer<typeof rtcSignal>;
export type PlayerReady = z.infer<typeof playerReady>;
export type PlayerPause = z.infer<typeof playerPause>;
export type GameSet = z.infer<typeof gameSet>;
export type GameStart = z.infer<typeof gameStart>;
export type StateSnapshot = z.infer<typeof stateSnapshot>;
export type ViewerSnapshot = z.infer<typeof viewerSnapshot>;
export type ViewerState = z.infer<typeof viewerState>;
export type VideoSet = z.infer<typeof videoSet>;
export type LivekitAccess = z.infer<typeof livekitAccess>;
export type HashMessage = z.infer<typeof hashMessage>;
export type Desync = z.infer<typeof desync>;
export type ScoreLive = z.infer<typeof scoreLive>;
export type GameEnd = z.infer<typeof gameEnd>;
export type InputRequest = z.infer<typeof inputRequest>;
export type InputResync = z.infer<typeof inputResync>;
export type Chat = z.infer<typeof chat>;
export type ErrorMessage = z.infer<typeof errorMessage>;

export type AnyMessage = z.infer<typeof anyMessage>;
export type ClientMessage = z.infer<typeof clientMessage>;
export type ServerMessage = z.infer<typeof serverMessage>;

/** Parse a JSON message, throwing a ZodError when it does not match. */
export function parseMessage(value: unknown): AnyMessage {
  return anyMessage.parse(value);
}

/** Non-throwing parse; inspect `result.success` before use. */
export function safeParseMessage(
  value: unknown,
): z.ZodSafeParseResult<AnyMessage> {
  return anyMessage.safeParse(value);
}
