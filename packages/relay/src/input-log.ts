/**
 * Per-match input log recorder (T30, docs/contracts/input-log.md). Opened on
 * `game.start`, appends decoded input packets (first write wins per
 * `(frame, slot)`, matching the T25 hash rule), and closes on `game.end` into
 * a dense `InputLog`. The stored artifact is gzip of the JSON bytes.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import {
  INPUT_LOG_VERSION,
  decodeInputLog,
  encodeInputLog,
  type InputLog,
  type InputLogGame,
  type InputPacket,
} from "@wma/protocol";

/** A seated player at match start (docs/contracts/input-log.md). */
export interface LogPlayer {
  slot: number;
  name: string;
}

export interface LogStart {
  frame: number;
  inputDelay: number;
  players: LogPlayer[];
}

export interface LogScore {
  slot: number;
  score: number;
}

export class InputLogRecorder {
  private readonly room: string;
  private readonly meta: InputLogGame;
  private readonly start: LogStart;
  private readonly masks = new Map<number, Map<number, number>>();
  private closed = false;

  constructor(room: string, meta: InputLogGame, start: LogStart) {
    this.room = room;
    this.meta = meta;
    this.start = start;
  }

  /**
   * Merge one decoded packet. Frames before `start.frame` are dropped, and a
   * repeated `(frame, slot)` keeps its first mask so a redundant overlapping
   * packet cannot change a frame already recorded. Returns whether anything new
   * was recorded.
   */
  append(packet: InputPacket): boolean {
    if (this.closed) return false;
    let recorded = false;
    packet.inputs.forEach((mask, offset) => {
      const frame = packet.firstFrame + offset;
      if (frame < this.start.frame) return;
      let row = this.masks.get(frame);
      if (!row) {
        row = new Map();
        this.masks.set(frame, row);
      }
      if (row.has(packet.player)) return;
      row.set(packet.player, mask & 0xffff);
      recorded = true;
    });
    return recorded;
  }

  /** Close the log at `endFrame`; frames after it are dropped. */
  close(endFrame: number, scores: LogScore[]): InputLog {
    this.closed = true;
    const last = Math.max(endFrame, this.start.frame);
    const delayEnd = this.start.frame + this.start.inputDelay;
    const frames: number[][] = [];
    for (let frame = this.start.frame; frame <= last; frame++) {
      const row = this.masks.get(frame);
      // The first `inputDelay` frames are neutral by construction (docs/03);
      // force zeros so a stray packet cannot produce an invalid log.
      const neutral = frame < delayEnd;
      frames.push(
        this.start.players.map((player) =>
          neutral ? 0 : (row?.get(player.slot) ?? 0),
        ),
      );
    }
    return {
      v: INPUT_LOG_VERSION,
      room: this.room,
      meta: {
        driver: this.meta.driver,
        core_hash: this.meta.coreHash,
        mame_commit: this.meta.mameCommit,
        rom_hash: this.meta.romHash,
        dips: { ...this.meta.dips },
        mode: this.start.players.length === 1 ? "solo" : "coop",
      },
      start: {
        frame: this.start.frame,
        input_delay: this.start.inputDelay,
        players: this.start.players.map((player) => ({ ...player })),
        start_state_key: null,
      },
      end: { frame: last, scores },
      frames,
    };
  }
}

/** Object-storage key for a closed log (docs/contracts/input-log.md). */
export function inputLogKey(room: string, logId: string): string {
  return `match/${room}/${logId}.json.gz`;
}

/** Encode a log into the stored artifact (gzip of its UTF-8 JSON). */
export function gzipInputLog(log: InputLog): Uint8Array {
  return new Uint8Array(gzipSync(encodeInputLog(log)));
}

/** Decode a stored artifact back into an `InputLog` (verifier/tests). */
export function gunzipInputLog(bytes: Uint8Array): InputLog {
  return decodeInputLog(new Uint8Array(gunzipSync(bytes)));
}
