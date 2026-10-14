/**
 * Anti-cheat input analysis (T36, docs/05, docs/07).
 *
 * Pure and deterministic: the same `InputLog` always produces the same report
 * (no clock, no randomness, no I/O). The verifier worker runs it on the closed
 * log after replay and persists findings as advisory `match_flags` rows — it
 * never changes the verified score or `matches.status`.
 *
 * Two heuristics, per player slot:
 *  - `periodic_input`: the mask column repeats on a fixed period (a recorded or
 *    scripted loop rather than human play).
 *  - `uniform_hold`: every press/release lasts exactly the same number of
 *    frames (a mechanical autofire cadence).
 */
import { type InputLog } from "@wma/protocol";

export type AntiCheatCode = "periodic_input" | "uniform_hold";

export interface AntiCheatFlag {
  code: AntiCheatCode;
  slot: number;
  detail: Record<string, number>;
}

export interface AntiCheatReport {
  suspect: boolean;
  flags: AntiCheatFlag[];
}

export interface AntiCheatOptions {
  /** Below this many analysed frames, never flag (avoid short-match noise). */
  minFrames?: number;
  /** Largest period searched by the periodicity test. */
  maxPeriod?: number;
  /** Fraction of lag-`p` frames that must match to call a column periodic. */
  periodicityThreshold?: number;
  /** Minimum number of hold-runs before a uniform cadence is called out. */
  minRuns?: number;
}

const DEFAULTS = {
  minFrames: 360,
  maxPeriod: 60,
  periodicityThreshold: 0.95,
  minRuns: 8,
} as const;

/** Extract player `j`'s mask column, dropping the neutral input-delay prefix. */
function column(frames: number[][], j: number, delay: number): number[] {
  return frames.slice(delay).map((row) => row[j] ?? 0);
}

function distinctMasks(col: number[]): Set<number> {
  return new Set(col);
}

/** Smallest period `p` whose lag-`p` equality reaches `threshold`, or null. */
function detectPeriod(
  col: number[],
  maxPeriod: number,
  threshold: number,
): { period: number; ratio: number } | null {
  const n = col.length;
  const limit = Math.min(maxPeriod, Math.floor(n / 4));
  for (let p = 2; p <= limit; p++) {
    let matches = 0;
    for (let i = p; i < n; i++) {
      if (col[i] === col[i - p]) matches++;
    }
    const ratio = matches / (n - p);
    if (ratio >= threshold) return { period: p, ratio };
  }
  return null;
}

function runLengths(col: number[]): number[] {
  if (col.length === 0) return [];
  const runs: number[] = [];
  let current = 1;
  for (let i = 1; i < col.length; i++) {
    if (col[i] === col[i - 1]) current++;
    else {
      runs.push(current);
      current = 1;
    }
  }
  runs.push(current);
  return runs;
}

/** Detect a cadence where every hold lasts the same number of frames. */
function detectUniformRuns(
  col: number[],
  minRuns: number,
): { runLength: number; runs: number } | null {
  const runs = runLengths(col);
  if (runs.length < minRuns) return null;
  const first = runs[0]!;
  if (first <= 0) return null;
  if (!runs.every((run) => run === first)) return null;
  return { runLength: first, runs: runs.length };
}

/**
 * Analyse a closed input log for inhumanly regular input. Flags are ordered by
 * player slot, then by a fixed code order within a slot.
 */
export function analyzeInputLog(
  log: InputLog,
  opts: AntiCheatOptions = {},
): AntiCheatReport {
  const minFrames = opts.minFrames ?? DEFAULTS.minFrames;
  const maxPeriod = opts.maxPeriod ?? DEFAULTS.maxPeriod;
  const periodicityThreshold =
    opts.periodicityThreshold ?? DEFAULTS.periodicityThreshold;
  const minRuns = opts.minRuns ?? DEFAULTS.minRuns;

  const delay = Math.min(log.start.input_delay, log.frames.length);
  const flags: AntiCheatFlag[] = [];

  for (let j = 0; j < log.start.players.length; j++) {
    const slot = log.start.players[j]!.slot;
    const col = column(log.frames, j, delay);
    if (col.length < minFrames) continue;

    if (distinctMasks(col).size >= 2) {
      const periodic = detectPeriod(col, maxPeriod, periodicityThreshold);
      if (periodic) {
        flags.push({
          code: "periodic_input",
          slot,
          detail: { period: periodic.period, ratio: periodic.ratio, frames: col.length },
        });
      }
    }

    const uniform = detectUniformRuns(col, minRuns);
    if (uniform) {
      flags.push({
        code: "uniform_hold",
        slot,
        detail: { run_length: uniform.runLength, runs: uniform.runs, frames: col.length },
      });
    }
  }

  return { suspect: flags.length > 0, flags };
}
