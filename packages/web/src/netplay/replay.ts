/**
 * Closed-match replay controller (T35). The offline sibling of the live viewer
 * (`viewer.ts`): instead of the relay's input stream it reads a stored
 * `InputLog` (docs/contracts/input-log.md) and steps a frozen core from
 * `start.frame` to `end.frame`, once per emulated frame.
 *
 * Determinism (AGENTS.md): only the log's masks reach `core.step`; nothing else
 * does. The injected `now` decides *when* a frame is stepped, never *what* — no
 * `Date.now`, no `Math.random`. The same `now` sequence always yields the same
 * step trace, so the replay reproduces the match on the same core build.
 */
import type { InputLog } from "@wma/protocol";
import type { Core, FrameInputs, StateHash } from "../core/types";

export type ReplayStatus = "playing" | "paused" | "ended";

export interface ReplayProgress {
  /** Frames stepped so far, i.e. the next frame to step. */
  frame: number;
  /** Last frame in the log (inclusive). */
  endFrame: number;
}

export interface ReplayDeps {
  /** A frozen, netplay-armed core (the replay is its sole driver). */
  core: Core;
  /** The decoded closed input log. */
  log: InputLog;
  /** Emulated frame duration in milliseconds; default 1000/60. */
  frameMs?: number;
  /** Start playing on the first tick; default true. */
  autoplay?: boolean;
  /** Cap frames stepped per tick; default 8. */
  maxPerTick?: number;
  onStatus?: (status: ReplayStatus) => void;
  onProgress?: (progress: ReplayProgress) => void;
}

export interface Replay {
  /** Step the frames due at wall-clock `now`; call once per animation frame. */
  tick(now: number): void;
  /** The next frame to step (equals `endFrame + 1` once ended). */
  frame(): number;
  /** The log's last frame, inclusive. */
  endFrame(): number;
  status(): ReplayStatus;
  pause(): void;
  play(): void;
  /** Restore the boot snapshot and replay from `start.frame` again. */
  restart(): void;
  /** Current core hash (a replaying core's CRC32); for tests/e2e. */
  bootHash(): StateHash;
  destroy(): void;
}

const DEFAULT_FRAME_MS = 1000 / 60;
const DEFAULT_MAX_PER_TICK = 8;

/**
 * The four-slot input tuple for one absolute frame, from the log's row. The row
 * is aligned to `start.players` order, not slot order, so `row[j]` is placed at
 * `start.players[j].slot`. A frame before the log or with no row is neutral.
 */
export function frameInputsAt(log: InputLog, frame: number): FrameInputs {
  const inputs: [number, number, number, number] = [0, 0, 0, 0];
  if (frame < log.start.frame) return inputs;
  const row = log.frames[frame - log.start.frame];
  if (!row) return inputs;
  for (let j = 0; j < row.length; j++) {
    const player = log.start.players[j];
    if (player) inputs[player.slot] = row[j]! & 0xffff;
  }
  return inputs;
}

export function createReplay(deps: ReplayDeps): Replay {
  const frameMs = deps.frameMs ?? DEFAULT_FRAME_MS;
  const maxPerTick = deps.maxPerTick ?? DEFAULT_MAX_PER_TICK;
  const startFrame = deps.log.start.frame;
  const endFrame = deps.log.end.frame;
  // The core is frozen at boot here, so this is the state at `start.frame`
  // (the lockstep also starts stepping there). `restart` restores it via the
  // T25 recovery seam rather than a fresh boot.
  const bootState = deps.core.save();

  let playFrame = startFrame;
  let nextFrameTime = 0;
  let started = false;
  // Re-base the cadence to the next tick: at the first step and after a
  // (re)start, so a resume does not fast-forward through the paused interval
  // and an early tick never pushes the next step further out.
  let rebase = true;
  let status: ReplayStatus = deps.autoplay === false ? "paused" : "playing";

  function setStatus(next: ReplayStatus): void {
    if (status === next) return;
    status = next;
    deps.onStatus?.(next);
  }

  function report(): void {
    deps.onProgress?.({ frame: playFrame, endFrame });
  }

  function stepDue(now: number): void {
    if (!started || rebase) {
      nextFrameTime = now;
      started = true;
      rebase = false;
    }
    let stepped = 0;
    while (stepped < maxPerTick && playFrame <= endFrame && now >= nextFrameTime) {
      deps.core.step(playFrame, frameInputsAt(deps.log, playFrame));
      playFrame += 1;
      nextFrameTime += frameMs;
      stepped += 1;
    }
    if (playFrame > endFrame) setStatus("ended");
    if (stepped > 0) report();
  }

  return {
    tick(now: number): void {
      if (status !== "playing") return;
      stepDue(now);
    },
    frame: () => playFrame,
    endFrame: () => endFrame,
    status: () => status,
    pause(): void {
      if (status === "playing") setStatus("paused");
    },
    play(): void {
      if (status === "paused") {
        rebase = true;
        setStatus("playing");
      }
    },
    restart(): void {
      // `netplay_set_frame(startFrame - 1)` makes the next stepped frame
      // `startFrame` (the uint32 clock wraps for startFrame 0), mirroring the
      // lockstep's resume-at-frame-plus-one rule.
      deps.core.load(bootState, startFrame - 1);
      playFrame = startFrame;
      started = false;
      rebase = true;
      setStatus("playing");
      report();
    },
    bootHash: () => deps.core.hash(),
    destroy(): void {},
  };
}
