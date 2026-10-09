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
  players: z.array(z.strictObject({ slot, name: z.string() })),
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

export const hashMessage = z.strictObject({
  t: z.literal("hash"),
  frame,
  crc32: z.number().int().min(0).max(0xffffffff),
});

export const desync = z.strictObject({
  t: z.literal("desync"),
  frame,
});

export const scoreLive = z.strictObject({
  t: z.literal("score.live"),
  player: slot,
  score: z.number().int(),
  frame,
});

export const gameEnd = z.strictObject({
  t: z.literal("game.end"),
  frame,
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
  gameStart,
  stateSnapshot,
  hashMessage,
  desync,
  scoreLive,
  gameEnd,
  chat,
  errorMessage,
] as const;

/** Discriminated union of every JSON message, keyed on `t`. */
export const anyMessage = z.discriminatedUnion("t", jsonSchemas);

/** Messages a client may send to the relay (JSON subset). */
export const clientMessage = z.discriminatedUnion("t", [
  roomJoin,
  rtcSignal,
  gameStart,
  stateSnapshot,
  hashMessage,
  scoreLive,
  gameEnd,
  chat,
]);

/** Messages the relay may send to a client (JSON subset). */
export const serverMessage = z.discriminatedUnion("t", [
  roomState,
  rtcSignal,
  stateSnapshot,
  desync,
  scoreLive,
  chat,
  errorMessage,
]);

export type RoomJoin = z.infer<typeof roomJoin>;
export type RoomState = z.infer<typeof roomState>;
export type RtcSignal = z.infer<typeof rtcSignal>;
export type GameStart = z.infer<typeof gameStart>;
export type StateSnapshot = z.infer<typeof stateSnapshot>;
export type HashMessage = z.infer<typeof hashMessage>;
export type Desync = z.infer<typeof desync>;
export type ScoreLive = z.infer<typeof scoreLive>;
export type GameEnd = z.infer<typeof gameEnd>;
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
