/**
 * Live scoreboard state (T32): the latest score reported for each seated slot,
 * merged from our own samples and from peers. Pure and clock-free, so the match
 * orchestrator owns the cadence and this stays unit-tested without a browser.
 * Display only — nothing here touches the emulation path.
 */

export interface ScoreRow {
  slot: number;
  score: number;
}

export interface Scoreboard {
  /** Record the latest score for a slot (last write wins). */
  set(slot: number, score: number): void;
  /** Latest score for a slot, or undefined if it never reported. */
  get(slot: number): number | undefined;
  /** Every reported slot, ascending. */
  rows(): ScoreRow[];
  /** Forget all scores (a fresh match). */
  clear(): void;
}

export function createScoreboard(): Scoreboard {
  const scores = new Map<number, number>();
  return {
    set: (slot, score) => {
      scores.set(slot, score);
    },
    get: (slot) => scores.get(slot),
    rows: () =>
      [...scores.entries()]
        .sort(([a], [b]) => a - b)
        .map(([slot, score]) => ({ slot, score })),
    clear: () => {
      scores.clear();
    },
  };
}

/**
 * Whether a score sample is due at `now`, given the last sample time and the
 * interval in ms. `lastAt === null` means the cadence has not been armed yet,
 * so the first call is always due (the sampler arms it). Clock-injected: the
 * caller supplies `now`.
 */
export function isSampleDue(
  now: number,
  lastAt: number | null,
  intervalMs: number,
): boolean {
  return lastAt === null || now - lastAt >= intervalMs;
}
