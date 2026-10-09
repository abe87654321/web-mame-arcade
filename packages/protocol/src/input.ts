/**
 * Input mask bit layout and wire packet, single source of truth for
 * docs/contracts/input-packet.md. One u16 per player slot per frame; reserved
 * bits are not assigned to any button.
 */

/** Protocol version, matching docs/contracts/input-packet.md. */
export const PROTOCOL_VERSION = 1;

export const PLAYER_SLOTS = 4;

/** Maximum frames carried by one packet (contract: count is 1-8). */
export const MAX_FRAMES = 8;

/** Fixed header size before the u16 inputs: version(1)+player(1)+ack(4)+first(4)+count(1). */
export const INPUT_HEADER_SIZE = 11;

export const BUTTON_BITS = {
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
} as const;

export type Button = keyof typeof BUTTON_BITS;

/** Bits 12-15 are reserved (future analog/extra controls) per the contract. */
export const RESERVED_MASK = 0xf000;

/** Decoded wire packet (docs/contracts/input-packet.md). */
export interface InputPacket {
  version: number;
  /** Player slot, 0-3. */
  player: number;
  /** Latest frame received from the receiver. */
  ackFrame: number;
  /** Frame of inputs[0]. */
  firstFrame: number;
  /** One u16 button mask per frame, oldest first (1-8 entries). */
  inputs: number[];
}

function assertEncodable(packet: InputPacket): void {
  if (packet.player < 0 || packet.player >= PLAYER_SLOTS) {
    throw new RangeError(`player ${packet.player} outside 0..${PLAYER_SLOTS - 1}`);
  }
  if (packet.inputs.length < 1 || packet.inputs.length > MAX_FRAMES) {
    throw new RangeError(
      `inputs length ${packet.inputs.length} outside 1..${MAX_FRAMES}`,
    );
  }
}

/**
 * Encode an input packet as little-endian bytes (docs/contracts/input-packet.md).
 * Throws RangeError when player or frame count is out of contract.
 */
export function encodeInput(packet: InputPacket): Uint8Array {
  assertEncodable(packet);
  const { version, player, ackFrame, firstFrame, inputs } = packet;
  const bytes = new Uint8Array(INPUT_HEADER_SIZE + inputs.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, version);
  view.setUint8(1, player);
  view.setUint32(2, ackFrame, true);
  view.setUint32(6, firstFrame, true);
  view.setUint8(10, inputs.length);
  inputs.forEach((mask, i) => {
    view.setUint16(INPUT_HEADER_SIZE + i * 2, mask & 0xffff, true);
  });
  return bytes;
}

/**
 * Decode bytes produced by {@link encodeInput}. Throws RangeError on a wrong
 * version, an out-of-range player/count, or a length that disagrees with count.
 */
export function decodeInput(bytes: Uint8Array): InputPacket {
  if (bytes.length < INPUT_HEADER_SIZE) {
    throw new RangeError(
      `packet too short: ${bytes.length} < ${INPUT_HEADER_SIZE}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== PROTOCOL_VERSION) {
    throw new RangeError(`unsupported protocol version ${version}`);
  }
  const player = view.getUint8(1);
  if (player >= PLAYER_SLOTS) {
    throw new RangeError(`player ${player} outside 0..${PLAYER_SLOTS - 1}`);
  }
  const ackFrame = view.getUint32(2, true);
  const firstFrame = view.getUint32(6, true);
  const count = view.getUint8(10);
  if (count < 1 || count > MAX_FRAMES) {
    throw new RangeError(`count ${count} outside 1..${MAX_FRAMES}`);
  }
  if (bytes.length !== INPUT_HEADER_SIZE + count * 2) {
    throw new RangeError(
      `length ${bytes.length} does not match count ${count}`,
    );
  }
  const inputs = Array.from({ length: count }, (_, i) =>
    view.getUint16(INPUT_HEADER_SIZE + i * 2, true),
  );
  return { version, player, ackFrame, firstFrame, inputs };
}
