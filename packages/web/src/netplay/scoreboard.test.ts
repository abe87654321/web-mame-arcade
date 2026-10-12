import { describe, expect, it } from "vitest";
import { createScoreboard, isSampleDue } from "./scoreboard";

describe("createScoreboard", () => {
  it("starts empty", () => {
    expect(createScoreboard().rows()).toEqual([]);
  });

  it("records the latest score per slot, ascending", () => {
    const board = createScoreboard();
    board.set(1, 20);
    board.set(0, 10);
    expect(board.rows()).toEqual([
      { slot: 0, score: 10 },
      { slot: 1, score: 20 },
    ]);
    expect(board.get(0)).toBe(10);
    expect(board.get(2)).toBeUndefined();
  });

  it("overwrites a slot's score (last write wins)", () => {
    const board = createScoreboard();
    board.set(0, 5);
    board.set(0, 9);
    expect(board.get(0)).toBe(9);
  });

  it("clears on a fresh match", () => {
    const board = createScoreboard();
    board.set(0, 5);
    board.clear();
    expect(board.rows()).toEqual([]);
  });
});

describe("isSampleDue", () => {
  it("is due before the cadence is armed", () => {
    expect(isSampleDue(0, null, 1000)).toBe(true);
  });

  it("is not due before the interval elapses", () => {
    expect(isSampleDue(999, 0, 1000)).toBe(false);
  });

  it("is due once the interval elapses", () => {
    expect(isSampleDue(1000, 0, 1000)).toBe(true);
    expect(isSampleDue(5000, 0, 1000)).toBe(true);
  });
});
