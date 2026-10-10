/**
 * Gated netplay e2e hook (T26). A test run injects a per-slot, frame-indexed
 * mask table on `window.__WMA_TEST_INPUT__` before the page boots; when present
 * `createMatch` feeds those masks to the lockstep instead of the wall-clock
 * sampled ones. This makes the harness deterministic: a frame's input never
 * depends on when an animation frame fired, so two peers reach identical
 * machine state. It is inert unless the global is set, so production sampling
 * is unchanged. No clock and no randomness live here.
 */

export interface SlotScript {
  /** Dense per-frame masks; index is the frame number. */
  masks?: number[];
  /** Half-open [startFrame, endFrame) segments; the first match wins. */
  segments?: { startFrame: number; endFrame: number; mask: number }[];
}

export interface TestInputGlobal {
  /** Per-slot scripts keyed by slot number as a string (JSON object keys). */
  players?: Record<string, SlotScript>;
}

/** Resolve a script's mask for one frame; out-of-range frames read as 0. */
export function maskAt(script: SlotScript, frame: number): number {
  if (Array.isArray(script.masks)) return (script.masks[frame] ?? 0) & 0xffff;
  for (const s of script.segments ?? []) {
    if (frame >= s.startFrame && frame < s.endFrame) return s.mask & 0xffff;
  }
  return 0;
}

/**
 * Build a `(slot, frame) => mask` source from an injected global, or
 * `undefined` when no valid per-slot script is present.
 */
export function readInputScript(
  win: unknown,
): ((slot: number, frame: number) => number) | undefined {
  const global = (win as { __WMA_TEST_INPUT__?: TestInputGlobal } | undefined)
    ?.__WMA_TEST_INPUT__;
  if (!global || typeof global !== "object" || !global.players) return undefined;
  if (typeof global.players !== "object") return undefined;
  const players = global.players;
  return (slot, frame) => {
    const script = players[String(slot)];
    return script ? maskAt(script, frame) : 0;
  };
}
