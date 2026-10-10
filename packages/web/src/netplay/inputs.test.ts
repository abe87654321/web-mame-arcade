import { describe, expect, it } from "vitest";
import { MAX_FRAMES, PROTOCOL_VERSION, decodeInput } from "@wma/protocol";
import { applyPacket, buildInputPacket, createFrameTable } from "./inputs";

const mask = (n: number): number => n & 0xffff;

describe("buildInputPacket", () => {
  it("carries the last 8 consecutive frames, oldest first", () => {
    const frames = Array.from({ length: 10 }, (_, i) => mask(i + 1));

    const bytes = buildInputPacket({
      player: 2,
      ackFrame: 42,
      frames,
      endFrame: 9,
    });

    const packet = decodeInput(bytes);
    expect(packet).toEqual({
      version: PROTOCOL_VERSION,
      player: 2,
      ackFrame: 42,
      firstFrame: 2,
      inputs: frames.slice(2),
    });
    expect(packet.inputs).toHaveLength(MAX_FRAMES);
  });

  it("sends everything available when there are fewer than 8 frames", () => {
    const packet = decodeInput(
      buildInputPacket({ player: 0, ackFrame: 0, frames: [7, 8], endFrame: 3 }),
    );
    expect(packet.firstFrame).toBe(2);
    expect(packet.inputs).toEqual([7, 8]);
  });

  it("rejects an empty frame list", () => {
    expect(() =>
      buildInputPacket({ player: 0, ackFrame: 0, frames: [], endFrame: 0 }),
    ).toThrow(RangeError);
  });
});

describe("createFrameTable", () => {
  it("is ready only once every required slot has an input", () => {
    const table = createFrameTable([0, 1]);
    expect(table.ready(5)).toBe(false);
    expect(table.set(0, 5, mask(1))).toBe(true);
    expect(table.ready(5)).toBe(false);
    expect(table.set(1, 5, mask(2))).toBe(true);
    expect(table.ready(5)).toBe(true);
    expect(table.get(5)).toEqual([1, 2, 0, 0]);
  });

  it("keeps the first value for a frame (redundancy first-wins)", () => {
    const table = createFrameTable([0]);
    expect(table.set(0, 5, mask(1))).toBe(true);
    expect(table.set(0, 5, mask(9))).toBe(false);
    expect(table.get(5)[0]).toBe(1);
  });

  it("ignores a player that is not in the match", () => {
    const table = createFrameTable([0, 1]);
    expect(table.set(3, 5, mask(1))).toBe(false);
    expect(table.ready(5)).toBe(false);
  });

  it("tracks the highest frame seen per player", () => {
    const table = createFrameTable([0, 1]);
    expect(table.ackOf(0)).toBe(-1);
    table.set(0, 4, 0);
    table.set(0, 7, 0);
    table.set(0, 3, 0);
    expect(table.ackOf(0)).toBe(7);
    expect(table.ackOf(1)).toBe(-1);
  });

  it("drops frames below the prune floor and refuses to refill them", () => {
    const table = createFrameTable([0]);
    table.set(0, 3, mask(1));
    table.prune(5);
    expect(table.set(0, 3, mask(2))).toBe(false);
    expect(table.ready(3)).toBe(false);
    expect(table.set(0, 5, mask(3))).toBe(true);
  });
});

describe("applyPacket", () => {
  it("stages every frame carried by the packet", () => {
    const table = createFrameTable([1, 0]);
    const bytes = buildInputPacket({
      player: 1,
      ackFrame: 0,
      frames: [mask(4), mask(5)],
      endFrame: 6,
    });

    applyPacket(table, bytes);

    expect(table.get(5)[1]).toBe(4);
    expect(table.get(6)[1]).toBe(5);
    expect(table.ready(5)).toBe(false);
  });

  it("propagates a decode error for malformed bytes", () => {
    const table = createFrameTable([0]);
    expect(() => applyPacket(table, new Uint8Array([9, 9, 9]))).toThrow(RangeError);
  });

  it("drops a packet that claims our own slot", () => {
    const table = createFrameTable([0, 1]);
    const bytes = buildInputPacket({ player: 0, ackFrame: 0, frames: [9], endFrame: 0 });

    applyPacket(table, bytes, 0);

    expect(table.ackOf(0)).toBe(-1);
  });
});
