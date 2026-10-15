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

/** Scores above this cannot round-trip through a JS number. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function toSafeNumber(value: bigint): number {
  if (value > MAX_SAFE) {
    throw new Error("scoremap: score exceeds Number.MAX_SAFE_INTEGER");
  }
  return Number(value);
}

/**
 * Combine raw score bytes into a decimal score per the entry's `format` and
 * `endian` (docs/contracts/scoremap.md).
 *
 * - `binary`: fold the bytes MSB-first; `little` means the lowest address is the
 *   least-significant byte.
 * - `bcd`: place the bytes most-significant-byte first, then emit each byte's
 *   high nibble then low nibble as decimal digits; a nibble > 9 is invalid.
 *
 * Accumulated with BigInt so a wide entry cannot silently lose precision; a
 * value above `Number.MAX_SAFE_INTEGER` is rejected rather than rounded.
 */
export function decodeScore(
  bytes: Uint8Array,
  entry: Pick<ScoreMapEntry, "format" | "endian" | "len" | "divisor">,
): number {
  if (bytes.length !== entry.len) {
    throw new Error(
      `scoremap: read length ${bytes.length} != expected ${entry.len}`,
    );
  }
  // MSB-first view: big-endian is already in address order; little-endian is
  // stored least-significant byte first, so reverse it.
  const ordered = entry.endian === "big" ? bytes : Uint8Array.from(bytes).reverse();

  const value = ((): bigint => {
    if (entry.format === "binary") {
      let v = 0n;
      for (const byte of ordered) v = v * 256n + BigInt(byte);
      return v;
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
    return BigInt(digits);
  })();

  // Some games store the score scaled (e.g. ×10); `divisor` recovers the
  // on-screen score (docs/contracts/scoremap.md).
  const scaled = entry.divisor && entry.divisor > 1 ? value / BigInt(entry.divisor) : value;
  return toSafeNumber(scaled);
}

/**
 * Fetch and parse a driver's scoremap. `undefined`/no `url` or a **404** yields
 * `undefined`: the driver simply has no live score. Any other failure (a 5xx, a
 * network error) or a malformed body throws — a deploy error should fail loudly.
 */
export async function loadScoreMap(
  url: string | undefined,
  fetchImpl: ScoreMapFetch = fetch,
): Promise<ScoreMap | undefined> {
  if (!url) return undefined;
  const response = await fetchImpl(url);
  if (!response.ok) {
    if (response.status === 404) return undefined;
    throw new Error(`scoremap: fetch ${url} failed (${response.status ?? "?"})`);
  }
  return parseScoreMap(await response.json());
}
