/**
 * Delay-based lockstep loop (T24, docs/03-netplay-protocol.md). The caller
 * samples this browser's own controls (as a mask) and hands it to `tick`;
 * the loop schedules it under `mySlot` `inputDelay` frames ahead, sends a
 * redundant packet, and steps every frame whose inputs from all players are
 * present. Late input parks the loop; after `waitTimeoutMs` it reports
 * "waiting" so the UI can show a pause.
 *
 * Determinism: the simulation advances only through `core.step(frame, inputs)`.
 * The injected `now()` clock is consulted solely for the wait UX and never
 * reaches the emulation path; there is no `Math.random`, no `Date.now`.
 */
import { MAX_FRAMES } from "@wma/protocol";
import type { Core } from "../core/types";
import { applyPacket, buildInputPacket, createFrameTable } from "./inputs";

export type LockstepStatus = "running" | "waiting";

export interface LockstepDeps {
  /** Only `step` is used: the loop owns the frame clock. */
  core: Pick<Core, "step">;
  /** This browser's player slot; it owns that slot's local input. */
  mySlot: number;
  /** Occupied player slots, including `mySlot`. */
  players: readonly number[];
  /** Local input delay D in frames (docs/03: 2-3). */
  inputDelay: number;
  /** First frame to simulate; 0 for a fresh boot. */
  startFrame: number;
  /** Send one encoded packet to every peer and to the relay. */
  sendInput: (packet: Uint8Array) => void;
  /** Milliseconds clock for the wait timer only. */
  now: () => number;
  /** Status transitions ("waiting"/"running"); never called every tick. */
  onStatus?: (status: LockstepStatus) => void;
  /** Report "waiting" after this many ms without the next frame. */
  waitTimeoutMs?: number;
  /** Cap how far the local schedule may run ahead of the simulation. */
  maxLookahead?: number;
}

export interface Lockstep {
  /**
   * One animation tick: schedule the freshly sampled local mask for this
   * browser's own slot, send, and advance every ready frame.
   */
  tick(localMask: number): void;
  /** Feed an encoded packet from a peer or the relay. */
  onBytes(bytes: Uint8Array): void;
  /** The next frame to simulate. */
  frame(): number;
  status(): LockstepStatus;
}

const DEFAULT_WAIT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_LOOKAHEAD = 256;

export function createLockstep(deps: LockstepDeps): Lockstep {
  const { core, mySlot, players, inputDelay, startFrame, sendInput, now } = deps;
  const waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const maxLookahead = deps.maxLookahead ?? DEFAULT_MAX_LOOKAHEAD;

  const table = createFrameTable(players);
  let current = startFrame;
  let scheduleHead = startFrame + inputDelay;
  // Masks for consecutive frames ending at scheduleHead-1; trimmed to the last
  // MAX_FRAMES because only that many are ever sent.
  const frames: number[] = [];

  // The delay frames are neutral on every peer, so the first real input lands
  // D frames after the start without anyone inventing a mask.
  for (let frame = startFrame; frame < scheduleHead; frame++) {
    table.set(mySlot, frame, 0);
    frames.push(0);
  }

  let status: LockstepStatus = "running";
  let waitSince: number | null = null;

  function updateStatus(ready: boolean): void {
    if (ready) {
      if (waitSince === null) return;
      waitSince = null;
      if (status === "waiting") {
        status = "running";
        deps.onStatus?.("running");
      }
      return;
    }
    if (waitSince === null) {
      waitSince = now();
      return;
    }
    if (status !== "waiting" && now() - waitSince >= waitTimeoutMs) {
      status = "waiting";
      deps.onStatus?.("waiting");
    }
  }

  function stepReadyFrames(): void {
    while (table.ready(current)) {
      core.step(current, table.get(current));
      table.prune(current + 1);
      current += 1;
    }
  }

  return {
    tick(localMask: number): void {
      // Backpressure: while blocked, keep the schedule bounded rather than
      // queueing inputs the simulation may never reach.
      if (scheduleHead - current < maxLookahead) {
        const mask = localMask & 0xffff;
        table.set(mySlot, scheduleHead, mask);
        frames.push(mask);
        scheduleHead += 1;
      }

      if (frames.length > 0) {
        sendInput(
          buildInputPacket({
            player: mySlot,
            // Informational until rollback (T40); a per-peer ack would need a
            // separate packet per peer, which the broadcast path does not do.
            ackFrame: Math.max(0, current - 1),
            frames,
            endFrame: scheduleHead - 1,
          }),
        );
        if (frames.length > MAX_FRAMES) {
          frames.splice(0, frames.length - MAX_FRAMES);
        }
      }

      stepReadyFrames();
      // Only "waiting" when we have already sampled the frame we are stuck on;
      // reaching scheduleHead just means the next tick has not happened yet.
      const stalled = current < scheduleHead && !table.ready(current);
      updateStatus(!stalled);
    },

    onBytes(bytes: Uint8Array): void {
      try {
        applyPacket(table, bytes, mySlot);
      } catch {
        // Malformed or foreign-version packets are dropped; a bad peer must not
        // crash the loop.
      }
    },

    frame: () => current,
    status: () => status,
  };
}
