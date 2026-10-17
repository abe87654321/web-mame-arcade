/**
 * Rollback netplay loop (T40, docs/03-netplay-protocol.md). Unlike delay-based
 * lockstep, a missing remote input does not stall the match: the loop predicts
 * it from that player's last confirmed mask, steps ahead, and rewinds when the
 * real packet arrives.
 *
 * Invariants:
 * - Only `core.step(frame, inputs)` advances the machine. Prediction changes
 *   *when* a frame runs, never which inputs it ends up with.
 * - A frame can be corrected only while its predecessor's snapshot is still in
 *   the ring, so the loop never runs more than `window` frames ahead of the
 *   slowest confirmed peer. This keeps every late packet recoverable.
 * - Re-simulation is incremental: at most one already-shown frame per animation
 *   tick. A slow core therefore never exceeds the frame budget with a burst of
 *   rewinds; it briefly slows down until the correction is caught up.
 * - Hashes are reported only for frames that can no longer be corrected. The
 *   relay drops stale frames (`frame < hashFrame`), so a predicted hash for a
 *   still-correctable frame could trigger a false desync.
 * - The injected clock is used for the wait UX and the local over-load meter
 *   only; it never reaches the emulation path.
 */
import { MAX_FRAMES } from "@wma/protocol";
import type { Core, FrameInputs } from "../core/types";
import { applyPacket, buildInputPacket, createFrameTable } from "./inputs";
import type { LockstepStatus, NetplayLoop } from "./lockstep";

export interface RollbackDeps {
  /** The loop owns the frame clock; snapshots make corrections possible. */
  core: Pick<Core, "step" | "save" | "load" | "setSilent" | "renderNow">;
  mySlot: number;
  players: readonly number[];
  /** Local input delay D in frames; the host announces it in `game.start`. */
  inputDelay: number;
  /** First frame to simulate; 0 for a fresh boot. */
  startFrame: number;
  /** Send one encoded packet to every peer and to the relay. */
  sendInput: (packet: Uint8Array) => void;
  /** Milliseconds clock for the wait timer only. */
  now: () => number;
  /** Status transitions ("waiting"/"running"); never called every tick. */
  onStatus?: (status: LockstepStatus) => void;
  /** CRC32 of the machine state at the frame just stepped. */
  hash?: () => number;
  /** Report a hash every this many frames; default 60. */
  hashInterval?: number;
  /** Receives `(frame, crc32)` once the frame can no longer be corrected. */
  onHash?: (frame: number, crc32: number) => void;
  /** Report "waiting" after this many ms without progress. */
  waitTimeoutMs?: number;
  /** Called once when the loop stalls (prediction budget exhausted). */
  onStall?: (frame: number) => void;
  /** Called when a stall persists past `stallEscalateMs`. */
  onStallEscalate?: (frame: number) => void;
  /** Escalate a still-stalled loop after this many ms; default 6000. */
  stallEscalateMs?: number;
  /** Cap how far the local schedule may run ahead of the simulation. */
  maxLookahead?: number;
  /**
   * Correctable-frame window, 2..8; default 8. A smaller window costs less CPU
   * (fewer frames to re-simulate) but tolerates less jitter.
   */
  window?: number;
  /** Refuse to start when the ring would exceed this many bytes; default 64 MiB. */
  maxMemoryBytes?: number;
  /**
   * High-resolution clock for the local over-load meter. Defaults to `now`.
   * It only decides when to stop predicting; it never reaches `core.step`.
   */
  perfNow?: () => number;
  /** Called once when the loop degrades to wait-only for the rest of the match. */
  onDegrade?: (reason: RollbackDegradeReason) => void;
}

/** Why rollback gave up predicting (T40). */
export type RollbackDegradeReason = "slow" | "rollbacks";

export interface RollbackStats {
  /** Number of rewinds performed. */
  rollbacks: number;
  /** Number of slot/frame inputs that were predicted (including re-sims). */
  predictions: number;
  /** Set when the loop gave up predicting for the rest of the match (T40). */
  degraded: boolean;
  /** Exponentially weighted per-frame rollback cost in ms (local telemetry). */
  emaCostMs: number;
}

export interface RollbackLoop extends NetplayLoop {
  stats(): RollbackStats;
}

const DEFAULT_WAIT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_LOOKAHEAD = 256;
const DEFAULT_HASH_INTERVAL = 60;
const DEFAULT_STALL_ESCALATE_MS = 6000;
const DEFAULT_WINDOW = 8;
const MIN_WINDOW = 2;
const MAX_WINDOW = 8;
const DEFAULT_MAX_MEMORY_BYTES = 64 * 1024 * 1024;
/** EMA per-tick rollback cost that triggers degradation. */
const DEGRADE_EMA_MS = 20;
/** Consecutive metered ticks above the threshold before degrading. */
const DEGRADE_EMA_TICKS = 60;
/** Frame span used for the rollback-storm detector. */
const DEGRADE_FRAME_WINDOW = 60;
/** Rewinds within one frame window that indicate a storm. */
const DEGRADE_ROLLBACKS = 20;
/** How many already-sent local masks a resync keeps for the input log (T40). */
const OWN_HISTORY_FRAMES = 600;

interface Snapshot {
  /** Last stepped frame this state belongs to. */
  frame: number;
  state: Uint8Array;
}

export function createRollback(deps: RollbackDeps): RollbackLoop {
  const { core, mySlot, players, inputDelay, startFrame, sendInput, now } = deps;
  const waitTimeoutMs = deps.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const maxLookahead = deps.maxLookahead ?? DEFAULT_MAX_LOOKAHEAD;
  const hashInterval = deps.hashInterval ?? DEFAULT_HASH_INTERVAL;
  const stallEscalateMs = deps.stallEscalateMs ?? DEFAULT_STALL_ESCALATE_MS;
  const window = Math.min(
    MAX_WINDOW,
    Math.max(MIN_WINDOW, Math.floor(deps.window ?? DEFAULT_WINDOW)),
  );
  const maxMemoryBytes = deps.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
  const perfNow = deps.perfNow ?? now;

  const table = createFrameTable(players);
  const history = new Map<number, FrameInputs>();
  const ring: Snapshot[] = [];
  const pendingHashes = new Map<number, number>();
  const dirty = new Set<number>();
  /** Masks for consecutive local frames ending at scheduleHead-1 (packet window). */
  const frames: number[] = [];
  // Local masks already sent, for replaying them after a resync (T40).
  const ownMasks = new Map<number, number>();

  let current = startFrame;
  let scheduleHead = startFrame + inputDelay;
  // The delay frames are neutral on every peer, so the first real input lands D
  // frames after the start without anyone inventing a mask.
  for (let frame = startFrame; frame < scheduleHead; frame++) {
    table.set(mySlot, frame, 0);
    frames.push(0);
    ownMasks.set(frame, 0);
  }

  let boot: Uint8Array;
  try {
    boot = core.save();
  } catch (error) {
    throw new Error(`rollback unavailable: ${String(error)}`);
  }
  if (!boot || boot.length === 0) {
    throw new Error("rollback unavailable: the core has no save state");
  }
  if (boot.length * (window + 2) > maxMemoryBytes) {
    throw new Error(
      `rollback memory budget exceeded: ${boot.length} bytes × ${window + 2}`,
    );
  }
  ring.push({ frame: startFrame - 1, state: boot });

  let status: LockstepStatus = "running";
  let waitSince: number | null = null;
  let lastEscalateAt: number | null = null;
  let paused = false;
  /** Last frame to re-simulate after a rewind, or null when not catching up. */
  let catchUp: number | null = null;
  /** True while the driver's draw is suppressed across catch-up ticks. */
  let renderSuppressed = false;
  const stats: RollbackStats = {
    rollbacks: 0,
    predictions: 0,
    degraded: false,
    emaCostMs: 0,
  };
  let emaTicks = 0;
  let framesSinceCheck = 0;
  let rollbacksSinceCheck = 0;
  let rollbacksAtLastCheck = 0;

  function degrade(reason: RollbackDegradeReason): void {
    if (stats.degraded) return;
    stats.degraded = true;
    deps.onDegrade?.(reason);
  }

  /**
   * Update the local over-load meter. Prediction only changes *when* a frame
   * runs, never the inputs it ends up with, so this cannot affect determinism.
   */
  function meter(startedAt: number, stepped: number): void {
    const cost = Math.max(0, perfNow() - startedAt);
    stats.emaCostMs =
      emaTicks === 0 ? cost : stats.emaCostMs * 0.95 + cost * 0.05;
    emaTicks += 1;
    framesSinceCheck += stepped;
    rollbacksSinceCheck += stats.rollbacks - rollbacksAtLastCheck;
    rollbacksAtLastCheck = stats.rollbacks;
    if (!stats.degraded && emaTicks >= DEGRADE_EMA_TICKS && stats.emaCostMs > DEGRADE_EMA_MS) {
      degrade("slow");
    }
    if (framesSinceCheck >= DEGRADE_FRAME_WINDOW) {
      if (!stats.degraded && rollbacksSinceCheck > DEGRADE_ROLLBACKS) {
        degrade("rollbacks");
      }
      framesSinceCheck = 0;
      rollbacksSinceCheck = 0;
    }
  }

  /** When degraded, wait for every real input instead of predicting. */
  function readyToStep(frame: number): boolean {
    return stats.degraded ? table.ready(frame) : canStep(frame);
  }

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
      deps.onStall?.(current);
      lastEscalateAt = now();
      return;
    }
    if (status === "waiting") {
      const at = now();
      if (lastEscalateAt === null) lastEscalateAt = at;
      if (at - lastEscalateAt >= stallEscalateMs) {
        lastEscalateAt = at;
        deps.onStallEscalate?.(current);
      }
    }
  }

  /** Newest confirmed frame for `player` before `frame`; `startFrame - 1` if none. */
  function lastConfirmedFrame(player: number, frame: number): number {
    const floor = Math.max(startFrame - 1, frame - 1 - window);
    for (let candidate = frame - 1; candidate >= floor; candidate--) {
      if (table.has(player, candidate)) return candidate;
    }
    return startFrame - 1;
  }

  /** True once every peer is confirmed or within the prediction window. */
  function canStep(frame: number): boolean {
    for (const player of players) {
      if (table.has(player, frame)) continue;
      if (frame - lastConfirmedFrame(player, frame) > window) return false;
    }
    return true;
  }

  /** Inputs for `frame`: confirmed masks, otherwise last-confirmed prediction. */
  function resolve(frame: number): { inputs: FrameInputs; predicted: number } {
    const inputs: number[] = [];
    let predicted = 0;
    for (let slot = 0; slot < 4; slot++) {
      let value = 0;
      if (players.includes(slot)) {
        const confirmed = table.at(slot, frame);
        if (confirmed === undefined) {
          value = table.lastBefore(slot, frame) ?? 0;
          predicted += 1;
        } else {
          value = confirmed;
        }
      }
      inputs.push(value);
    }
    return {
      inputs: inputs as unknown as FrameInputs,
      predicted,
    };
  }

  function savePoint(frame: number): void {
    ring.push({ frame, state: core.save() });
    // Keep the point for `current - window - 1`: it is the earliest state a
    // still-correctable frame may need.
    const oldest = current - window - 1;
    while (ring.length > 0 && ring[0]!.frame < oldest) ring.shift();
  }

  function noteHash(frame: number): void {
    if (!deps.hash || !deps.onHash) return;
    if (frame <= 0 || frame % hashInterval !== 0) return;
    pendingHashes.set(frame, deps.hash());
  }

  function flushHashes(): void {
    if (!deps.onHash) return;
    const framesToSend = [...pendingHashes.keys()].sort((a, b) => a - b);
    for (const frame of framesToSend) {
      // Final once no snapshot for frame - 1 is retained: the earliest
      // rewind target is `current - window`.
      if (frame > current - window - 1) break;
      deps.onHash(frame, pendingHashes.get(frame)!);
      pendingHashes.delete(frame);
    }
  }

  function stepFrame(frame: number): void {
    const { inputs, predicted } = resolve(frame);
    core.step(frame, inputs);
    history.set(frame, inputs);
    stats.predictions += predicted;
    current = frame + 1;
    savePoint(frame);
    noteHash(frame);
  }

  /** Find the earliest dirty frame whose re-simulated inputs would change. */
  function earliestMismatch(): number | null {
    let earliest: number | null = null;
    for (const frame of dirty) {
      if (frame > current - 1) continue;
      const used = history.get(frame);
      if (!used) continue;
      for (const player of players) {
        const actual = table.at(player, frame);
        if (actual !== undefined && actual !== used[player]) {
          if (earliest === null || frame < earliest) earliest = frame;
          break;
        }
      }
    }
    return earliest;
  }

  function suppressRender(on: boolean): void {
    if (on === renderSuppressed) return;
    renderSuppressed = on;
    core.setSilent?.(on);
    if (!on) core.renderNow?.();
  }

  /** Rewind to `frame - 1`; the replay continues one frame per tick. */
  function rewindTo(frame: number): void {
    const target = frame - 1;
    const point = ring.find((snapshot) => snapshot.frame === target);
    if (!point) return;
    // If a correction is already in flight, its target is the last frame the
    // original (pre-correction) timeline reached.
    const lastStepped = catchUp !== null ? Math.max(catchUp, current - 1) : current - 1;
    // Frames the player already saw do not need to be redrawn; the corrected
    // current frame is rendered once catch-up finishes (T40).
    suppressRender(true);
    core.load(point.state, point.frame);
    current = frame;
    catchUp = lastStepped;
    // Drop snapshots and hashes from the abandoned timeline; the incremental
    // replay rebuilds them from `frame` on.
    while (ring.length > 0 && ring[ring.length - 1]!.frame >= target) ring.pop();
    ring.push(point);
    for (const pending of [...pendingHashes.keys()]) {
      if (pending >= frame) pendingHashes.delete(pending);
    }
    stats.rollbacks += 1;
  }

  function reconcile(): void {
    if (dirty.size === 0) return;
    const earliest = earliestMismatch();
    if (earliest !== null) rewindTo(earliest);
    // Frames whose confirmed value already matches (or that are now in the
    // past and were covered by the replay) carry no further work.
    dirty.clear();
  }

  return {
    tick(localMask: number): void {
      if (paused) return;
      const startedAt = perfNow();
      const frameBefore = current;
      reconcile();
      if (scheduleHead - current < maxLookahead) {
        const mask = localMask & 0xffff;
        if (table.set(mySlot, scheduleHead, mask)) {
          frames.push(mask);
          ownMasks.set(scheduleHead, mask);
        }
        scheduleHead += 1;
        if (scheduleHead % OWN_HISTORY_FRAMES === 0) {
          const floor = scheduleHead - OWN_HISTORY_FRAMES;
          for (const own of ownMasks.keys()) {
            if (own < floor) ownMasks.delete(own);
          }
        }
      }
      if (frames.length > 0) {
        sendInput(
          buildInputPacket({
            player: mySlot,
            // Informational: rollback needs actual frames, not a per-peer ack.
            ackFrame: Math.max(0, current - 1),
            frames,
            endFrame: scheduleHead - 1,
          }),
        );
        if (frames.length > MAX_FRAMES) {
          frames.splice(0, frames.length - MAX_FRAMES);
        }
      }

      if (catchUp !== null) {
        // Re-simulate exactly one already-shown frame, then yield to the next
        // animation tick. This keeps a slow core under its frame budget.
        stepFrame(current);
        if (current > catchUp) {
          catchUp = null;
          suppressRender(false);
        }
        flushHashes();
        meter(startedAt, current - frameBefore);
        updateStatus(true);
        return;
      }

      while (current < scheduleHead && readyToStep(current)) stepFrame(current);
      flushHashes();
      meter(startedAt, current - frameBefore);
      const stalled = current < scheduleHead && !readyToStep(current);
      updateStatus(!stalled);
    },

    onBytes(bytes: Uint8Array): void {
      try {
        const packet = applyPacket(table, bytes, mySlot);
        if (packet.player !== mySlot) {
          packet.inputs.forEach((_value, i) => dirty.add(packet.firstFrame + i));
        }
      } catch {
        // Malformed or foreign-version packets are dropped.
      }
    },

    resync(frame: number, state?: Uint8Array): void {
      catchUp = null;
      suppressRender(false);
      // Keep the local masks for frames after the snapshot: they were already
      // sent and the relay log holds them first-wins (T40).
      const own: number[] = [];
      for (let at = frame + 1; at < scheduleHead; at++) {
        const mask = ownMasks.get(at);
        if (mask === undefined) break;
        own.push(mask);
      }
      current = frame + 1;
      table.clear(current);
      history.clear();
      pendingHashes.clear();
      dirty.clear();
      frames.length = 0;
      scheduleHead = current;
      if (own.length > 0) {
        own.forEach((mask, i) => table.set(mySlot, current + i, mask));
        scheduleHead = current + own.length;
        frames.push(...own.slice(-MAX_FRAMES));
      }
      ring.splice(0, ring.length, { frame, state: state ?? core.save() });
      waitSince = null;
      lastEscalateAt = null;
      if (status === "waiting") {
        status = "running";
        deps.onStatus?.("running");
      }
    },

    pause(): void {
      paused = true;
      waitSince = null;
      lastEscalateAt = null;
    },

    resume(): void {
      paused = false;
      waitSince = null;
      lastEscalateAt = null;
      if (status === "waiting") {
        status = "running";
        deps.onStatus?.("running");
      }
    },

    paused: () => paused,
    frame: () => current,
    scheduledFrame: () => scheduleHead,
    status: () => status,
    stats: () => ({ ...stats }),
  };
}
