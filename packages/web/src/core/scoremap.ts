/**
 * Driver scoremap loader and decoder (T32b). The scoremap (docs/contracts/
 * scoremap.md, schema in `@wma/protocol`) says where a slot's live score lives
 * in emulated memory and how to turn those bytes into a decimal score.
 *
 * `decodeScore` is pure; `loadScoreMap` fetches `/static/scoremap/<driver>.json`,
 * treating a 404 as "no live score for this driver" rather than an error. The
 * native read itself lives behind `Core.readScore` / `NetplayHooks.readMemory`.
 */
import {
  parseScoreMap,
  type ScoreMap,
  type ScoreMapEntry,
} from "@wma/protocol";

/** Minimal fetch response shape so tests can pass a fake. */
export interface ScoreMapResponse {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
}

export type ScoreMapFetch = (url: string) => Promise<ScoreMapResponse>;

/**
 * Combine raw score bytes into a decimal score per the entry's `format` and
 * `endian` (docs/contracts/scoremap.md).
 *
 * - `binary`: fold the bytes MSB-first; `little` means the lowest address is the
 *   least-significant byte.
 * - `bcd`: place the bytes most-significant-byte first, then emit each byte's
 *   high nibble then low nibble as decimal digits; a nibble > 9 is invalid.
 */
export function decodeScore(
  bytes: Uint8Array,
  entry: Pick<ScoreMapEntry, "format" | "endian" | "len">,
): number {
  if (bytes.length !== entry.len) {
    throw new Error(
      `scoremap: read length ${bytes.length} != expected ${entry.len}`,
    );
  }
  // MSB-first view: big-endian is already in address order; little-endian is
  // stored least-significant byte first, so reverse it.
  const ordered = entry.endian === "big" ? bytes : Uint8Array.from(bytes).reverse();

  if (entry.format === "binary") {
    let value = 0;
    for (const byte of ordered) value = value * 256 + byte;
    return value;
  }

  let digits = "";
  for (const byte of ordered) {
    const high = byte >> 4;
    const low = byte & 0x0f;
    if (high > 9 || low > 9) {
      throw new Error(`scoremap: invalid BCD byte 0x${byte.toString(16)}`);
    }
    digits += `${high}${low}`;
  }
  return Number(digits);
}

/**
 * Fetch and parse a driver's scoremap. `undefined`/no `url` or a non-ok
 * response (e.g. a 404) yields `undefined`: the driver simply has no live score.
 * A malformed body throws (a deploy error should fail loudly).
 */
export async function loadScoreMap(
  url: string | undefined,
  fetchImpl: ScoreMapFetch = fetch,
): Promise<ScoreMap | undefined> {
  if (!url) return undefined;
  const response = await fetchImpl(url);
  if (!response.ok) return undefined;
  return parseScoreMap(await response.json());
}
