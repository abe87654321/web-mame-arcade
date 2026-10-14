import { describe, expect, it } from "vitest";
import { INPUT_LOG_VERSION, type InputLog } from "@wma/protocol";
import { analyzeInputLog } from "./anti-cheat";

const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

/** Build a two-player log whose slot-0 column is `col` (slot-1 always 0). */
function makeLog(col: number[], inputDelay = 0): InputLog {
  return {
    v: INPUT_LOG_VERSION,
    room: "r1",
    meta: {
      driver: "gridlee",
      core_hash: HASH,
      mame_commit: COMMIT,
      rom_hash: HASH,
      dips: {},
      mode: "solo",
    },
    start: {
      frame: 0,
      input_delay: inputDelay,
      players: [{ slot: 0, name: "alice" }],
      start_state_key: null,
    },
    end: { frame: col.length - 1, scores: [] },
    frames: col.map((mask) => [mask]),
  };
}

/** Repeat `pattern` until the column is `length` frames long. */
function cycle(pattern: number[], length: number): number[] {
  return Array.from({ length }, (_, i) => pattern[i % pattern.length]!);
}

/** A varied, human-looking column: hold lengths differ and drift over time. */
function humanColumn(length: number): number[] {
  const col: number[] = [];
  let i = 0;
  const holds = [3, 7, 4, 11, 5, 2, 8, 6, 13, 4, 9, 3, 6, 10, 5, 7];
  while (col.length < length) {
    const on = holds[i % holds.length]!;
    const off = holds[(i * 3 + 1) % holds.length]!;
    for (let k = 0; k < on && col.length < length; k++) col.push(1);
    for (let k = 0; k < off && col.length < length; k++) col.push(0);
    i++;
  }
  return col;
}

describe("analyzeInputLog", () => {
  it("does not flag a varied, human-looking match", () => {
    expect(analyzeInputLog(makeLog(humanColumn(800)))).toEqual({
      suspect: false,
      flags: [],
    });
  });

  it("flags a perfectly periodic (recorded) input column", () => {
    const report = analyzeInputLog(makeLog(cycle([0, 1], 800)));
    expect(report.suspect).toBe(true);
    const periodic = report.flags.find((f) => f.code === "periodic_input");
    expect(periodic?.slot).toBe(0);
    expect(periodic?.detail.period).toBe(2);
  });

  it("flags a mechanical uniform on/off cadence", () => {
    const report = analyzeInputLog(
      makeLog(cycle([1, 1, 1, 1, 1, 0, 0, 0, 0, 0], 800)),
    );
    const uniform = report.flags.find((f) => f.code === "uniform_hold");
    expect(uniform?.detail.run_length).toBe(5);
    expect(report.suspect).toBe(true);
  });

  it("never flags a match shorter than the minimum sample", () => {
    expect(analyzeInputLog(makeLog(cycle([0, 1], 100)))).toEqual({
      suspect: false,
      flags: [],
    });
  });

  it("does not flag an all-neutral match (delay window neutral by construction)", () => {
    expect(analyzeInputLog(makeLog(new Array(800).fill(0), 2))).toEqual({
      suspect: false,
      flags: [],
    });
  });

  it("is deterministic for the same log", () => {
    const log = makeLog(cycle([0, 1, 1], 900));
    expect(analyzeInputLog(log)).toEqual(analyzeInputLog(log));
  });
});
