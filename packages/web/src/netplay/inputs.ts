/**
 * Input frame table and the redundant wire packet (T24). The lockstep loop
 * keeps every player's mask per frame here; a packet repeats the last
 * `MAX_FRAMES` (8) local frames so a single loss is not fatal
 * (docs/03-netplay-protocol.md, docs/contracts/input-packet.md).
 *
 * Pure and I/O-free: no clock, no sockets. `set` is first-wins because
 * redundancy makes duplicate frames normal, and a frame the clock already
 * stepped must never be rewritten.
 */
import {
  MAX_FRAMES,
  PROTOCOL_VERSION,
  decodeInput,
  encodeInput,
  type InputPacket,
} from "@wma/protocol";
import type { FrameInputs } from "../core/types";

const UNKNOWN = -1;

export interface FrameTable {
  /** True once every required player's inputs for `frame` are present. */
  ready(frame: number): boolean;
  /** Record a player's mask for a frame; first write wins. */
  set(player: number, frame: number, mask: number): boolean;
  /** Combined four-slot tuple for a frame; missing slots read as 0. */
  get(frame: number): FrameInputs;
  /** Highest frame seen from `player`, or -1. */
  ackOf(player: number): number;
  /** Forget frames below `before` (already stepped) and refuse to refill them. */
  prune(before: number): void;
}

export function createFrameTable(slots: readonly number[]): FrameTable {
  const required = new Set(slots);
  const known = new Map<number, Int32Array>();
  const ack = new Map<number, number>();
  let floor = 0;

  return {
    ready(frame: number): boolean {
      const entry = known.get(frame);
      if (!entry) return false;
      for (const slot of slots) {
        if (entry[slot] === UNKNOWN) return false;
      }
      return true;
    },

    set(player: number, frame: number, mask: number): boolean {
      if (!required.has(player) || frame < floor) return false;
      const entry = known.get(frame) ?? new Int32Array(4).fill(UNKNOWN);
      if (entry[player] !== UNKNOWN) return false;
      entry[player] = mask & 0xffff;
      known.set(frame, entry);
      const current = ack.get(player) ?? -1;
      if (frame > current) ack.set(player, frame);
      return true;
    },

    get(frame: number): FrameInputs {
      const entry = known.get(frame);
      const at = (slot: number): number => {
        const value = entry?.[slot];
        return value === undefined || value === UNKNOWN ? 0 : value;
      };
      return [at(0), at(1), at(2), at(3)];
    },

    ackOf: (player) => ack.get(player) ?? -1,

    prune(before: number): void {
      for (const frame of known.keys()) {
        if (frame < before) known.delete(frame);
      }
      if (before > floor) floor = before;
    },
  };
}

export interface BuildPacketOptions {
  player: number;
  /** Latest frame received from the receiver (docs/contracts/input-packet.md). */
  ackFrame: number;
  /** Masks per consecutive local frame, oldest first. */
  frames: readonly number[];
  /** Frame number of the last entry; `firstFrame` follows from the window. */
  endFrame: number;
}

/** Encode the last up-to-8 consecutive frames as a redundant input packet. */
export function buildInputPacket(options: BuildPacketOptions): Uint8Array {
  const { player, ackFrame, frames, endFrame } = options;
  if (frames.length === 0) {
    throw new RangeError("buildInputPacket requires at least one frame");
  }
  const count = Math.min(frames.length, MAX_FRAMES);
  const inputs = frames.slice(frames.length - count).map((m) => m & 0xffff);
  const packet: InputPacket = {
    version: PROTOCOL_VERSION,
    player,
    ackFrame,
    firstFrame: endFrame - count + 1,
    inputs,
  };
  return encodeInput(packet);
}

/** Decode a packet and stage every frame it carries. Returns the packet. */
export function applyPacket(table: FrameTable, bytes: Uint8Array): InputPacket {
  const packet = decodeInput(bytes);
  packet.inputs.forEach((value, i) => {
    table.set(packet.player, packet.firstFrame + i, value);
  });
  return packet;
}
