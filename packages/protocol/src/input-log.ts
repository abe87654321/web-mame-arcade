/**
 * Closed-match input log, single source of truth for
 * docs/contracts/input-log.md. The relay builds one on `game.end`; the verifier
 * (T33) replays it. The codec is pure JSON (UTF-8 bytes); gzip is the storage
 * layer's job, so this stays dependency-free and browser-safe.
 */
import { z } from "zod";
import { PLAYER_SLOTS } from "./input.ts";

/** Log format version, matching docs/contracts/input-log.md. */
export const INPUT_LOG_VERSION = 1;

const hash = z.string().regex(/^[0-9a-f]{64}$/, "lowercase sha256 hex");
const slot = z.number().int().min(0).max(PLAYER_SLOTS - 1);
const mask = z.number().int().min(0).max(0xffff);
const frame = z.number().int().min(0).max(0xffffffff);

export const inputLogMeta = z.strictObject({
  driver: z.string().min(1),
  core_hash: hash,
  mame_commit: z.string().regex(/^[0-9a-f]{40}$/, "lowercase 40-hex commit"),
  rom_hash: hash,
  dips: z.record(z.string(), z.union([z.string(), z.number()])),
  mode: z.enum(["solo", "coop"]),
});

export const inputLogStart = z.strictObject({
  frame,
  input_delay: z.number().int().min(0),
  players: z.array(z.strictObject({ slot, name: z.string() })).min(1),
  // `null` = the frame-0 boot state is the start state (docs/contracts/input-log.md).
  start_state_key: z.string().min(1).nullable(),
});

export const inputLogEnd = z.strictObject({
  frame,
  scores: z.array(z.strictObject({ slot, score: z.number().int() })),
});

export const inputLog = z
  .strictObject({
    v: z.literal(INPUT_LOG_VERSION),
    room: z.string().min(1),
    meta: inputLogMeta,
    start: inputLogStart,
    end: inputLogEnd,
    frames: z.array(z.array(mask)),
  })
  .superRefine((log, ctx) => {
    const expected = log.end.frame - log.start.frame + 1;
    if (expected < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["end", "frame"],
        message: "end.frame must be >= start.frame",
      });
    } else if (log.frames.length !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["frames"],
        message: `frames length ${log.frames.length} != ${expected}`,
      });
    }
    // First `input_delay` frames must be neutral (docs/03): no peer emits a mask
    // inside the delay window, so a non-zero one is a malformed log.
    const delay = Math.min(log.start.input_delay, log.frames.length);
    for (let i = 0; i < delay; i++) {
      if (log.frames[i]?.some((value) => value !== 0)) {
        ctx.addIssue({
          code: "custom",
          path: ["frames", i],
          message: "non-zero input inside the input delay window",
        });
      }
    }
    for (let i = 0; i < log.frames.length; i++) {
      if (log.frames[i]!.length !== log.start.players.length) {
        ctx.addIssue({
          code: "custom",
          path: ["frames", i],
          message: `frame row has ${log.frames[i]!.length} masks, expected ${log.start.players.length}`,
        });
        break;
      }
    }
  });

export type InputLogMeta = z.infer<typeof inputLogMeta>;
export type InputLogStart = z.infer<typeof inputLogStart>;
export type InputLogEnd = z.infer<typeof inputLogEnd>;
export type InputLog = z.infer<typeof inputLog>;

/** The match identity a `game.set` provides (docs/contracts/ws-messages.md). */
export interface InputLogGame {
  driver: string;
  coreHash: string;
  romHash: string;
  mameCommit: string;
  dips: Record<string, string | number>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Serialise a log to the UTF-8 JSON bytes stored (gzip applied by the store). */
export function encodeInputLog(log: InputLog): Uint8Array {
  return encoder.encode(JSON.stringify(log));
}

/** Parse and validate stored bytes (or JSON text) back into an `InputLog`. */
export function decodeInputLog(bytes: Uint8Array | string): InputLog {
  const text = typeof bytes === "string" ? bytes : decoder.decode(bytes);
  return inputLog.parse(JSON.parse(text));
}

/**
 * Index of `slot` within a log's `players` array, or -1 when the slot did not
 * play. Masks in `frames[i]` are aligned to this order.
 */
export function playerIndex(players: InputLogStart["players"], slot: number): number {
  return players.findIndex((player) => player.slot === slot);
}
