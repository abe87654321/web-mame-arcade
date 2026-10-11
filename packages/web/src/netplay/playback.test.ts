import { describe, expect, it } from "vitest";
import { encodeInput, type InputPacket } from "@wma/protocol";
import { createPlayback } from "./playback";

const FRAME_MS = 1000;

function packet(player: number, firstFrame: number, inputs: number[]): Uint8Array {
  return encodeInput({
    version: 1,
    player,
    ackFrame: 0,
    firstFrame,
    inputs,
  } satisfies InputPacket);
}

function playback(overrides: Partial<Parameters<typeof createPlayback>[0]> = {}) {
  return createPlayback({
    players: [0, 1],
    startFrame: 0,
    bufferMs: 3000,
    frameMs: FRAME_MS,
    maxPerTick: 4,
    ...overrides,
  });
}

/** Stage the same mask range [from, to] for both players, in wire-sized chunks. */
function feed(
  pb: ReturnType<typeof createPlayback>,
  from: number,
  to: number,
  mask = 0x10,
): void {
  for (let start = from; start <= to; start += 8) {
    const end = Math.min(start + 7, to);
    const inputs = Array.from({ length: end - start + 1 }, () => mask);
    pb.onBytes(packet(0, start, inputs));
    pb.onBytes(packet(1, start, inputs));
  }
}

describe("createPlayback", () => {
  it("does not step before the buffer is filled", () => {
    const pb = playback();
    feed(pb, 0, 2); // liveFrame 2 < startFrame + 3 buffers
    expect(pb.tick(0)).toEqual([]);
    expect(pb.frame()).toBe(0);
  });

  it("starts bufferFrames behind live and steps at the frame rate", () => {
    const pb = playback();
    feed(pb, 0, 5); // bufferFrames = 3, so play from frame 2
    expect(pb.tick(0)).toEqual([]); // starts, but nothing is due yet
    expect(pb.frame()).toBe(2);
    feed(pb, 6, 20); // live advances; the buffer edge moves with it
    expect(pb.tick(FRAME_MS)).toEqual([[0x10, 0x10, 0, 0]]);
    expect(pb.frame()).toBe(3);
    expect(pb.tick(2 * FRAME_MS)).toEqual([[0x10, 0x10, 0, 0]]);
    expect(pb.frame()).toBe(4);
  });

  it("stalls while an input is missing, then resumes without skipping", () => {
    const pb = playback();
    pb.onBytes(packet(0, 0, [0x1, 0x1, 0x1, 0x1, 0x1, 0x1])); // frames 0..5
    pb.onBytes(packet(1, 0, [0x2, 0x2])); // frames 0..1 only
    expect(pb.tick(0)).toEqual([]); // start at playFrame 2
    expect(pb.frame()).toBe(2);
    expect(pb.tick(10 * FRAME_MS)).toEqual([]); // frame 2 needs player 1
    expect(pb.frame()).toBe(2);
    pb.onBytes(packet(1, 2, [0x2, 0x2, 0x2, 0x2])); // frames 2..5
    const stepped = pb.tick(11 * FRAME_MS);
    expect(stepped[0]).toEqual([0x1, 0x2, 0, 0]);
    expect(pb.frame()).toBeGreaterThan(2);
  });

  it("catches up in bounded bursts after a stall", () => {
    const pb = playback();
    feed(pb, 0, 10);
    pb.tick(0); // start: playFrame = 10 - 3 = 7
    feed(pb, 11, 100); // a long stall while frames pile up
    const burst = pb.tick(1000 * FRAME_MS);
    expect(burst).toHaveLength(4); // capped by maxPerTick
    expect(pb.frame()).toBe(11);
    expect(pb.tick(1001 * FRAME_MS)).toHaveLength(4);
  });

  it("seek drops the timeline and resumes at frame + 1", () => {
    const pb = playback();
    feed(pb, 0, 10);
    pb.tick(0);
    pb.seek(4);
    expect(pb.frame()).toBe(5);
    feed(pb, 5, 12, 0xaa);
    pb.tick(2000 * FRAME_MS); // start buffering from 5
    const stepped = pb.tick(3000 * FRAME_MS);
    expect(stepped.length).toBeGreaterThan(0);
    expect(stepped[0]?.[0]).toBe(0xaa);
  });

  it("ignores malformed packets without crashing", () => {
    const pb = playback();
    expect(() => pb.onBytes(new Uint8Array([1, 2, 3]))).not.toThrow();
    feed(pb, 0, 5);
    expect(pb.tick(0)).toEqual([]);
  });
});
