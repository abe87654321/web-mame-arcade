/**
 * Per-driver scoremap, single source of truth for `core/scoremap/<driver>.json`
 * (T32, docs/contracts/scoremap.md). Read by the browser (T32b `Core.readScore`)
 * and, in the same shape, by the native verifier (T33). A file lists one entry
 * per seated player slot: where that slot's live score lives in emulated memory
 * and how to decode it.
 */
import { z } from "zod";
import { PLAYER_SLOTS } from "./input.ts";

/** Log format version, matching docs/contracts/scoremap.md. */
export const SCOREMAP_VERSION = 1;

const slot = z.number().int().min(0).max(PLAYER_SLOTS - 1);

export const scoreMapEntry = z.strictObject({
  slot,
  /** CPU device tag, e.g. ":maincpu". */
  cpu: z.string().min(1),
  /** MAME address space the score lives in (docs/contracts/scoremap.md). */
  space: z.enum(["program", "io"]),
  /** Byte address, `0x`-prefixed hex. */
  addr: z.string().regex(/^0x[0-9a-fA-F]+$/, "0x-prefixed hex address"),
  /** Number of bytes to read. */
  len: z.number().int().min(1).max(8),
  /** How to combine the bytes into a decimal score. */
  format: z.enum(["bcd", "binary"]),
  /** Byte order; defaults to little-endian (docs/contracts/scoremap.md). */
  endian: z.enum(["little", "big"]).optional(),
  /**
   * Divide the decoded value by this (default 1). Some games store the score
   * scaled (e.g. ×10); the divisor recovers the on-screen score.
   */
  divisor: z.number().int().min(1).optional(),
});

export const scoreMap = z
  .strictObject({
    v: z.literal(SCOREMAP_VERSION),
    players: z.array(scoreMapEntry),
  })
  // Each slot maps to one memory region, so a duplicate slot is a malformed map
  // (docs/contracts/scoremap.md); reject it rather than silently picking one.
  .refine(
    (map) => new Set(map.players.map((player) => player.slot)).size === map.players.length,
    { message: "scoremap slots must be unique", path: ["players"] },
  );

export type ScoreMapEntry = z.infer<typeof scoreMapEntry>;
export type ScoreMap = z.infer<typeof scoreMap>;

/** Parse and validate a scoremap (from JSON), or throw a ZodError. */
export function parseScoreMap(value: unknown): ScoreMap {
  return scoreMap.parse(value);
}
