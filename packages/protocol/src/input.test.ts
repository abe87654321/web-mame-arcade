import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BUTTON_BITS,
  INPUT_HEADER_SIZE,
  MAX_FRAMES,
  PLAYER_SLOTS,
  RESERVED_MASK,
  decodeInput,
  encodeInput,
  type InputPacket,
} from "./input";

describe("button bits", () => {
  it("maps each button to its contract bit", () => {
    expect(BUTTON_BITS).toEqual({
      up: 0x0001,
      down: 0x0002,
      left: 0x0004,
      right: 0x0008,
      b1: 0x0010,
      b2: 0x0020,
      b3: 0x0040,
      b4: 0x0080,
      b5: 0x0100,
      b6: 0x0200,
      start: 0x0400,
      coin: 0x0800,
    });
  });

  it("leaves bits 12-15 reserved and unused", () => {
    expect(RESERVED_MASK).toBe(0xf000);
    for (const bit of Object.values(BUTTON_BITS)) {
      expect(bit & RESERVED_MASK).toBe(0);
    }
  });

  it("never shares a bit between two buttons", () => {
    const bits = Object.values(BUTTON_BITS);
    expect(new Set(bits).size).toBe(bits.length);
  });

  it("supports four player slots", () => {
    expect(PLAYER_SLOTS).toBe(4);
  });
});

const validPacket: InputPacket = {
  version: 1,
  player: 1,
  ackFrame: 0x01020304,
  firstFrame: 0x00000064,
  inputs: [0x0001, 0x0010],
};

describe("encodeInput", () => {
  it("lays out the little-endian header and inputs per the contract", () => {
    const bytes = encodeInput(validPacket);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(INPUT_HEADER_SIZE + 2 * 2);
    expect([...bytes]).toEqual([
      1, // version
      1, // player
      0x04, 0x03, 0x02, 0x01, // ack_frame (LE u32)
      0x64, 0x00, 0x00, 0x00, // first_frame (LE u32)
      2, // count
      0x01, 0x00, // inputs[0] (LE u16)
      0x10, 0x00, // inputs[1] (LE u16)
    ]);
  });

  it("round-trips a full u16 mask without truncation", () => {
    const decoded = decodeInput(encodeInput({ ...validPacket, inputs: [0xffff] }));
    expect(decoded.inputs).toEqual([0xffff]);
  });

  it("rejects counts outside 1..8 and players outside the slot range", () => {
    expect(() => encodeInput({ ...validPacket, inputs: [] })).toThrow();
    expect(() =>
      encodeInput({ ...validPacket, inputs: new Array(MAX_FRAMES + 1).fill(0) }),
    ).toThrow();
    expect(() => encodeInput({ ...validPacket, player: PLAYER_SLOTS })).toThrow();
    expect(() => encodeInput({ ...validPacket, player: -1 })).toThrow();
  });
});

describe("decodeInput", () => {
  it("round-trips every valid packet", () => {
    const arbPacket = fc.record({
      version: fc.constant(1),
      player: fc.integer({ min: 0, max: PLAYER_SLOTS - 1 }),
      ackFrame: fc.integer({ min: 0, max: 0xffffffff }),
      firstFrame: fc.integer({ min: 0, max: 0xffffffff }),
      inputs: fc.array(fc.integer({ min: 0, max: 0xffff }), {
        minLength: 1,
        maxLength: MAX_FRAMES,
      }),
    });
    fc.assert(
      fc.property(arbPacket, (packet) => {
        expect(decodeInput(encodeInput(packet))).toEqual(packet);
      }),
      { numRuns: 500, seed: 1 },
    );
  });

  it("rejects a truncated header", () => {
    expect(() => decodeInput(new Uint8Array(INPUT_HEADER_SIZE - 1))).toThrow();
  });

  it("rejects a wrong protocol version", () => {
    const bytes = encodeInput({ ...validPacket, version: 2 });
    expect(() => decodeInput(bytes)).toThrow();
  });

  it("rejects a count/length mismatch", () => {
    const good = encodeInput(validPacket);
    expect(() => decodeInput(good.subarray(0, good.length - 1))).toThrow();
    const overlong = new Uint8Array(good.length + 2);
    overlong.set(good);
    expect(() => decodeInput(overlong)).toThrow();
  });

  it("rejects an out-of-range player and count", () => {
    const badPlayer = encodeInput(validPacket);
    badPlayer[1] = PLAYER_SLOTS;
    expect(() => decodeInput(badPlayer)).toThrow();

    const badCount = encodeInput(validPacket);
    badCount[10] = MAX_FRAMES + 1;
    expect(() => decodeInput(badCount)).toThrow();
  });
});
