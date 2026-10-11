import { describe, expect, it } from "vitest";
import type { InputPacket } from "@wma/protocol";
import {
  InputLogRecorder,
  gzipInputLog,
  gunzipInputLog,
  inputLogKey,
  type LogStart,
} from "./input-log";

const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

const meta = {
  driver: "gridlee",
  coreHash: HASH,
  romHash: HASH,
  mameCommit: COMMIT,
  dips: { Difficulty: "Medium" },
};

function start(overrides: Partial<LogStart> = {}): LogStart {
  return {
    frame: 0,
    inputDelay: 2,
    players: [
      { slot: 0, name: "alice" },
      { slot: 1, name: "bob" },
    ],
    ...overrides,
  };
}

function packet(
  player: number,
  firstFrame: number,
  inputs: number[],
): InputPacket {
  return { version: 1, player, ackFrame: 0, firstFrame, inputs };
}

describe("InputLogRecorder", () => {
  it("closes into dense frames aligned to the players order", () => {
    const rec = new InputLogRecorder("r1", meta, start());
    rec.append(packet(0, 2, [1, 4]));
    rec.append(packet(1, 2, [0, 0x10]));
    const log = rec.close(3, [{ slot: 0, score: 7 }]);

    expect(log.room).toBe("r1");
    expect(log.meta.mode).toBe("coop");
    expect(log.meta.core_hash).toBe(HASH);
    expect(log.start.players).toEqual([
      { slot: 0, name: "alice" },
      { slot: 1, name: "bob" },
    ]);
    expect(log.start.start_state_key).toBeNull();
    expect(log.end).toEqual({ frame: 3, scores: [{ slot: 0, score: 7 }] });
    expect(log.frames).toEqual([
      [0, 0],
      [0, 0],
      [1, 0],
      [4, 0x10],
    ]);
  });

  it("keeps the first mask for a repeated (frame, slot)", () => {
    const rec = new InputLogRecorder("r1", meta, start());
    rec.append(packet(0, 2, [0x10]));
    rec.append(packet(0, 2, [0x20]));
    const log = rec.close(2, []);
    expect(log.frames[2]).toEqual([0x10, 0]);
  });

  it("ignores frames before start.frame", () => {
    const rec = new InputLogRecorder("r1", meta, start({ frame: 5 }));
    expect(rec.append(packet(0, 0, [0x10, 0x20, 0x40, 0x80, 0x01]))).toBe(false);
    const log = rec.close(5, []);
    expect(log.frames).toEqual([[0, 0]]);
  });

  it("forces the input delay window neutral", () => {
    const rec = new InputLogRecorder("r1", meta, start());
    rec.append(packet(0, 0, [0x10, 0x10, 0x10]));
    const log = rec.close(2, []);
    expect(log.frames).toEqual([
      [0, 0],
      [0, 0],
      [0x10, 0],
    ]);
  });

  it("reports solo for a one-player log", () => {
    const rec = new InputLogRecorder("r1", meta, start({ players: [{ slot: 0, name: "solo" }] }));
    const log = rec.close(0, []);
    expect(log.meta.mode).toBe("solo");
  });

  it("drops appends after close", () => {
    const rec = new InputLogRecorder("r1", meta, start());
    rec.close(0, []);
    expect(rec.append(packet(0, 1, [1]))).toBe(false);
  });
});

describe("InputLogRecorder.since / lastFrame", () => {
  it("reports start.frame - 1 before any input", () => {
    const rec = new InputLogRecorder("r1", meta, start({ frame: 5 }));
    expect(rec.lastFrame()).toBe(4);
    expect(rec.since(0)).toEqual([]);
  });

  it("reports the highest recorded frame", () => {
    const rec = new InputLogRecorder("r1", meta, start());
    rec.append(packet(0, 0, [1, 2]));
    rec.append(packet(1, 2, [0x10, 0x20, 0x40]));
    expect(rec.lastFrame()).toBe(4);
  });

  it("re-encodes dense frames per slot from a floor, gaps and delay neutral", () => {
    const rec = new InputLogRecorder("r1", meta, start());
    rec.append(packet(0, 0, [0x1, 0x2, 0x3, 0x4]));
    rec.append(packet(1, 2, [0x10, 0x20]));
    const packets = rec.since(0);
    expect(packets).toEqual([
      { version: 1, player: 0, ackFrame: 0, firstFrame: 0, inputs: [0, 0, 0x3, 0x4] },
      { version: 1, player: 1, ackFrame: 0, firstFrame: 0, inputs: [0, 0, 0x10, 0x20] },
    ]);
  });

  it("chunks long ranges into MAX_FRAMES packets", () => {
    const rec = new InputLogRecorder(
      "r1",
      meta,
      start({ inputDelay: 0, players: [{ slot: 0, name: "alice" }] }),
    );
    rec.append(packet(0, 0, Array.from({ length: 20 }, (_, i) => i + 1)));
    const packets = rec.since(0);
    expect(packets.map((p) => [p.firstFrame, p.inputs.length])).toEqual([
      [0, 8],
      [8, 8],
      [16, 4],
    ]);
    expect(packets[2]?.inputs).toEqual([17, 18, 19, 20]);
  });

  it("starts at the requested floor", () => {
    const rec = new InputLogRecorder(
      "r1",
      meta,
      start({ inputDelay: 0, players: [{ slot: 0, name: "alice" }] }),
    );
    rec.append(packet(0, 0, [1, 2, 3, 4, 5]));
    const packets = rec.since(3);
    expect(packets).toEqual([
      { version: 1, player: 0, ackFrame: 0, firstFrame: 3, inputs: [4, 5] },
    ]);
  });
});

describe("log artifact", () => {
  it("gzip round-trips through the stored encoding", () => {
    const rec = new InputLogRecorder("r1", meta, start());
    rec.append(packet(0, 2, [1, 2]));
    const log = rec.close(3, []);
    const bytes = gzipInputLog(log);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(gunzipInputLog(bytes)).toEqual(log);
  });

  it("builds a namespaced object key", () => {
    expect(inputLogKey("r1", "abc")).toBe("match/r1/abc.json.gz");
  });
});
