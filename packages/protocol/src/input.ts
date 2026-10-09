/**
 * Input mask bit layout, single source of truth for docs/contracts/input-packet.md.
 * One u16 per player slot per frame; reserved bits are not assigned to any button.
 * `encodeInput`/`decodeInput` for the wire packet are added in T21.
 */

export const PLAYER_SLOTS = 4;

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
