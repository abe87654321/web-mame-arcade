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
  /**
   * CRC32 of the machine state at the frame just stepped (T25). Called only at
   * hash boundaries; requires the T20 netplay core.
   */
  hash?: () => number;
  /** Report a hash every this many frames; default 60 (docs/03). */
  hashInterval?: number;
  /** Receives `(frame, crc32)` at each boundary; the match forwards it to the relay. */
  onHash?: (frame: number, crc32: number) => void;
  /** Report "waiting" after this many ms without the next frame. */
  waitTimeoutMs?: number;
  /**
   * Called once when the loop stalls (the next frame's inputs are late), with
   * the frame it is waiting on. Lets the caller ask the relay to resend the
   * recorded inputs (T31 stall recovery).
   */
  onStall?: (frame: number) => void;
  /**
   * Called when a stall persists past `stallEscalateMs` (T29 mutual-stall
   * recovery). Fires at most once per interval while the loop stays stalled, so
   * the host can fall back to a full `state.snapshot` when a resend never
   * arrives (both peers lost the frame's input). Never consulted while paused.
   */
  onStallEscalate?: (frame: number) => void;
  /** Escalate a still-stalled loop after this many ms; default 6000 (T29). */
  stallEscalateMs?: number;
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
  /**
   * Resume after the machine was restored to the state at `frame` (desync
   * recovery, T25). Drops the stepped history and continues from `frame + 1`.
   */
  resync(frame: number): void;
  /** The next frame to simulate. */
  frame(): number;
  /**
   * The frame the next `tick` will schedule local input for. Used by the
   * scripted-input e2e hook (T26) to feed a deterministic, frame-indexed mask
   * instead of a wall-clock-sampled one.
   */
  scheduledFrame(): number;
  status(): LockstepStatus;
  /**
   * Freeze the loop (T29 collaborative pause): `tick` becomes a no-op — no
   * local input scheduled, nothing sent, nothing stepped — until `resume`.
   * Inbound packets are still buffered. Pause is control-only; it never enters
   * the emulation path, so it cannot affect determinism.
   */
  pause(): void;
  /** Resume after `pause()`; the stall timer restarts so there is no false stall. */
  resume(): void;
  /** Whether the loop is currently paused. */
  paused(): boolean;
}

const DEFAULT_WAIT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_LOOKAHEAD = 256;
const DEFAULT_HASH_INTERVAL = 60;
const DEFAULT_STALL_ESCALATE_MS = 6000;

export function createLockstep(deps: LockstepDeps): Lockstep {
  const { core, mySlot, players, inputDelay, startFrame, sendInput, now } = deps;
  const waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const maxLookahead = deps.maxLookahead ?? DEFAULT_MAX_LOOKAHEAD;
  const hashInterval = deps.hashInterval ?? DEFAULT_HASH_INTERVAL;
  const stallEscalateMs = deps.stallEscalateMs ?? DEFAULT_STALL_ESCALATE_MS;

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
  let lastEscalateAt: number | null = null;
  let paused = false;

  function updateStatus(ready: boolean): void {
    if (ready) {
      if (waitSince === null) return;
      waitSince = null;
      lastEscalateAt = null;
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
      // The next frame's inputs are late beyond the redundancy window; ask for
      // a resend so we are not stuck forever (T31 stall recovery).
      deps.onStall?.(current);
      lastEscalateAt = now();
      return;
    }
    // The resend did not unstick us within a longer interval: the host may need
    // to fall back to a full snapshot (T29 mutual-stall recovery). Pause never
    // runs this path because `tick` returns early while paused.
    if (status === "waiting") {
      const at = now();
      if (lastEscalateAt === null) lastEscalateAt = at;
      if (at - lastEscalateAt >= stallEscalateMs) {
        lastEscalateAt = at;
        deps.onStallEscalate?.(current);
      }
    }
  }

  function stepReadyFrames(): void {
    while (table.ready(current)) {
      core.step(current, table.get(current));
      // Hash right after the frame is stepped so `hash()` reflects exactly the
      // frame reported, even when one tick crosses several boundaries (T25).
      if (
        deps.hash &&
        deps.onHash &&
        current > 0 &&
        current % hashInterval === 0
      ) {
        deps.onHash(current, deps.hash());
      }
      table.prune(current + 1);
      current += 1;
    }
  }

  return {
    tick(localMask: number): void {
      // Paused (T29): schedule nothing, send nothing, step nothing. Inbound
      // packets still buffer via `onBytes`, so nothing is lost while paused.
      if (paused) return;
      // Backpressure: while blocked, keep the schedule bounded rather than
      // queueing inputs the simulation may never reach.
      if (scheduleHead - current < maxLookahead) {
        const mask = localMask & 0xffff;
        // Only record/send the mask when the table accepted it, so the packet's
        // frame history always matches what will actually be stepped here
        // (first-wins means a resync or duplicate can make `set` return false).
        if (table.set(mySlot, scheduleHead, mask)) frames.push(mask);
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

    resync(frame: number): void {
      // The core was just restored to the state at `frame`; continue from the
      // next one with a clean input window. Every staged frame — including
      // already-buffered future inputs from the pre-snapshot timeline — is
      // dropped so nothing stale is stepped and the packet history restarts,
      // which also re-aligns peers that were an uneven number of frames ahead
      // (T25). NOTE: our own post-snapshot masks are re-sampled here, so if the
      // relay's first-wins input log already holds a different value for one of
      // those frames, a verifier replay could diverge; reconciling that is the
      // input-log/rollback work (T30/T33/T40), not this task.
      current = frame + 1;
      table.clear(current);
      scheduleHead = current;
      frames.length = 0;
      waitSince = null;
      lastEscalateAt = null;
      if (status === "waiting") {
        status = "running";
        deps.onStatus?.("running");
      }
    },

    pause(): void {
      paused = true;
      // Forget any in-progress wait so resuming starts the timers fresh.
      waitSince = null;
      lastEscalateAt = null;
    },

    resume(): void {
      paused = false;
      waitSince = null;
      lastEscalateAt = null;
      // If we paused while stalled, clear the stale "waiting" status too, or
      // `updateStatus` (which only clears it on the ready branch) would never
      // re-fire `onStall` and a non-host could not request a resend again.
      if (status === "waiting") {
        status = "running";
        deps.onStatus?.("running");
      }
    },

    paused: () => paused,
    frame: () => current,
    scheduledFrame: () => scheduleHead,
    status: () => status,
  };
}
