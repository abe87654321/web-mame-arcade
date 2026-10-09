/**
 * Input-mask bits, re-exported from @wma/protocol so the web input layer has a
 * single import point. See docs/contracts/input-packet.md.
 */
import {
  BUTTON_BITS as PROTOCOL_BUTTON_BITS,
  PLAYER_SLOTS as PROTOCOL_PLAYER_SLOTS,
  RESERVED_MASK as PROTOCOL_RESERVED_MASK,
  type Button,
} from "@wma/protocol";

export const BUTTON_BITS = PROTOCOL_BUTTON_BITS;
export const PLAYER_SLOTS = PROTOCOL_PLAYER_SLOTS;
export const RESERVED_MASK = PROTOCOL_RESERVED_MASK;
export type { Button };

/** The u16 bit for one logical button. */
export function bitFor(button: Button): number {
  return BUTTON_BITS[button];
}

/** Keep only the contract-defined bits: clear reserved bits and anything >15. */
export function toWireMask(mask: number): number {
  return mask & ~RESERVED_MASK & 0xffff;
}
