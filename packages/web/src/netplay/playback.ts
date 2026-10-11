/**
 * Viewer playback buffer (T31). Pure and clock-injected: it turns the decoded
 * input stream into the exact `FrameInputs` a viewer's frozen core must step,
 * holding a fixed buffer behind live (docs/04: 2-5 s) so jitter never stalls
 * the emulation, and catching up in bounded bursts after a stall.
 *
 * Determinism: stepping is driven only by the inputs the relay recorded, and a
 * frame is emitted only when every required player's mask is present, so the
 * viewer's state matches the players' for the same frame. The injected `now`
 * affects *when* frames are stepped, never *what* is stepped — no `Date.now`,
 * no `Math.random`.
 */
import { decodeInput, type InputPacket } from "@wma/protocol";
import type { FrameInputs } from "../core/types";
import { createFrameTable, type FrameTable } from "./inputs";

export interface PlaybackDeps {
  /** Occupied player slots (the frame table's required set). */
  players: readonly number[];
  /** First frame to simulate; the boot frame, or a snapshot frame + 1. */
  startFrame: number;
  /** How far behind live to play, in milliseconds (docs/04: 2000-5000). */
  bufferMs: number;
  /** Emulated frame duration in milliseconds. */
  frameMs: number;
  /** Cap frames stepped per tick while catching up; default 8. */
  maxPerTick?: number;
}

export interface Playback {
  /** Stage one encoded input packet (from the relay's viewer stream). */
  onBytes(bytes: Uint8Array): void;
  /** Frames due at wall-clock `now`, in order; usually 0 or 1 per tick. */
  tick(now: number): FrameInputs[];
  /** The next frame to step. */
  frame(): number;
  /** Resume after the core was loaded from a snapshot at `frame`. */
  seek(frame: number): void;
}

const DEFAULT_MAX_PER_TICK = 8;

export function createPlayback(deps: PlaybackDeps): Playback {
  const bufferFrames = Math.max(1, Math.ceil(deps.bufferMs / deps.frameMs));
  const maxPerTick = deps.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const { frameMs } = deps;
  const table: FrameTable = createFrameTable(deps.players);
  // Reference frame the buffer is measured from (startFrame, or a snapshot + 1).
  let resumeFrom = deps.startFrame;
  // Highest frame any packet covered (completeness is checked per frame).
  let liveFrame = deps.startFrame - 1;
  let playFrame = deps.startFrame;
  let nextFrameTime = 0;
  let started = false;

  return {
    onBytes(bytes: Uint8Array): void {
      let packet: InputPacket;
      try {
        packet = decodeInput(bytes);
      } catch {
        // A malformed or foreign packet must not stop playback.
        return;
      }
      if (packet.inputs.length === 0) return;
      packet.inputs.forEach((value, i) => {
        table.set(packet.player, packet.firstFrame + i, value);
      });
      const last = packet.firstFrame + packet.inputs.length - 1;
      if (last > liveFrame) liveFrame = last;
    },

    tick(now: number): FrameInputs[] {
      if (!started) {
        // Wait until a full buffer is staged, then start bufferFrames behind live.
        if (liveFrame - resumeFrom < bufferFrames) return [];
        playFrame = Math.max(resumeFrom, liveFrame - bufferFrames);
        nextFrameTime = now + frameMs;
        started = true;
      }
      const edge = liveFrame - bufferFrames; // frames past this stay buffered
      const stepped: FrameInputs[] = [];
      while (
        stepped.length < maxPerTick &&
        playFrame <= edge &&
        now >= nextFrameTime
      ) {
        if (!table.ready(playFrame)) break; // stall, never skip a frame's input
        stepped.push(table.get(playFrame));
        table.prune(playFrame + 1);
        playFrame += 1;
        nextFrameTime += frameMs;
      }
      // Idle at the buffer edge: reset the cadence so playback resumes promptly
      // when live advances, instead of banking wall-clock debt.
      if (stepped.length === 0) nextFrameTime = now + frameMs;
      return stepped;
    },

    frame: () => playFrame,

    seek(frame: number): void {
      resumeFrom = frame + 1;
      liveFrame = frame;
      playFrame = frame + 1;
      started = false;
      table.clear(frame + 1);
    },
  };
}
