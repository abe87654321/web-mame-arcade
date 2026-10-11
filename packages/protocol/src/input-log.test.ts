import { describe, expect, it } from "vitest";
import {
  INPUT_LOG_VERSION,
  decodeInputLog,
  encodeInputLog,
  inputLog,
  playerIndex,
  type InputLog,
} from "./input-log";

const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

function makeLog(overrides: Partial<InputLog> = {}): InputLog {
  const base: InputLog = {
    v: INPUT_LOG_VERSION,
    room: "r1",
    meta: {
      driver: "gridlee",
      core_hash: HASH,
      mame_commit: COMMIT,
      rom_hash: HASH,
      dips: { Difficulty: "Medium" },
      mode: "coop",
    },
    start: {
      frame: 0,
      input_delay: 2,
      players: [
        { slot: 0, name: "alice" },
        { slot: 1, name: "bob" },
      ],
      start_state_key: null,
    },
    end: { frame: 3, scores: [] },
    frames: [
      [0, 0],
      [0, 0],
      [1, 0],
      [0, 0x10],
    ],
  };
  return { ...base, ...overrides };
}

describe("input log codec", () => {
  it("round-trips through encode/decode", () => {
    const log = makeLog();
    expect(decodeInputLog(encodeInputLog(log))).toEqual(log);
  });

  it("accepts a log whose delay window is neutral", () => {
    expect(() => decodeInputLog(encodeInputLog(makeLog()))).not.toThrow();
  });

  it("rejects an unknown version", () => {
    const log = makeLog();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (log as any).v = 99;
    expect(() => inputLog.parse(log)).toThrow();
  });

  it("rejects frames whose length disagrees with start/end", () => {
    expect(() => inputLog.parse(makeLog({ frames: [[0, 0]] }))).toThrow(/frames length/);
  });

  it("rejects a non-zero mask inside the input delay window", () => {
    const log = makeLog();
    log.frames[0] = [0, 1];
    expect(() => inputLog.parse(log)).toThrow(/input delay/);
  });

  it("rejects a frame row with the wrong number of player masks", () => {
    const log = makeLog();
    log.frames[2] = [0];
    expect(() => inputLog.parse(log)).toThrow();
  });

  it("rejects a bad core hash", () => {
    const log = makeLog();
    log.meta.core_hash = "not-a-hash";
    expect(() => inputLog.parse(log)).toThrow();
  });

  it("finds a player's mask index by slot", () => {
    const players = makeLog().start.players;
    expect(playerIndex(players, 1)).toBe(1);
    expect(playerIndex(players, 3)).toBe(-1);
  });

  it("pins the stored JSON bytes (golden)", () => {
    // Guards the on-disk format: any field rename/nesting change must update
    // the golden and docs/contracts/input-log.md together.
    const golden =
      '{"v":1,"room":"r1","meta":{"driver":"gridlee","core_hash":"' +
      HASH +
      '","mame_commit":"' +
      COMMIT +
      '","rom_hash":"' +
      HASH +
      '","dips":{"Difficulty":"Medium"},"mode":"coop"},"start":{"frame":0,' +
      '"input_delay":2,"players":[{"slot":0,"name":"alice"},{"slot":1,"name":"bob"}],' +
      '"start_state_key":null},"end":{"frame":3,"scores":[]},' +
      '"frames":[[0,0],[0,0],[1,0],[0,16]]}';
    expect(new TextDecoder().decode(encodeInputLog(makeLog()))).toBe(golden);
  });
});
