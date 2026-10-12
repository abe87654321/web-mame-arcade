/**
 * Adaptive input delay (T29). The host measures the round-trip time to every
 * peer **in the lobby** (RTC `getStats`) and picks the lockstep delay once,
 * before the match starts, so every peer agrees on it via `game.start`
 * (docs/03-netplay-protocol.md, docs/contracts/input-packet.md).
 *
 * Pure and deterministic: no clock, no randomness. The result depends only on
 * the measured RTTs, so the chosen delay is reproducible for the same inputs.
 * A delay sized from the worst peer's RTT gives a late packet one delay window
 * to arrive before its frame is stepped, without over-delaying the match.
 */

export interface InputDelayOptions {
  /** Duration of one simulated frame in ms; defaults to 60 Hz. */
  frameMs?: number;
  /** Smallest delay in frames (docs/03: 2-3); default 2. */
  min?: number;
  /** Largest delay in frames; default 6. */
  max?: number;
}

const DEFAULT_FRAME_MS = 1000 / 60;
const DEFAULT_MIN_DELAY = 2;
const DEFAULT_MAX_DELAY = 6;

/**
 * Pick the input delay D from the peers' measured RTTs (ms). D is the worst
 * RTT rounded up to whole frames, plus one frame of headroom, clamped to
 * `[min, max]`. Non-finite/negative readings are ignored; with no usable
 * reading the delay floors at `min`.
 */
export function selectInputDelay(
  rttsMs: readonly number[],
  options: InputDelayOptions = {},
): number {
  const frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
  const min = options.min ?? DEFAULT_MIN_DELAY;
  const max = options.max ?? DEFAULT_MAX_DELAY;

  let worst = 0;
  for (const rtt of rttsMs) {
    if (Number.isFinite(rtt) && rtt > worst) worst = rtt;
  }
  const frames = Math.ceil(worst / frameMs) + 1;
  return Math.min(max, Math.max(min, frames));
}
