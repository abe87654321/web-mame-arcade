/**
 * Netplay match orchestrator (T24). Owns the session and the lockstep loop and
 * connects them to one `Core`:
 *
 * - `room.state` → the roster and our own slot; once every peer's data channel
 *   is open and the core has booted, the lowest-slot host sends `game.start`.
 * - `game.start` (fanned out by the relay) → every peer starts its lockstep at
 *   the agreed `startFrame`/`inputDelay`.
 * - lockstep packets go out over the data channels (`broadcast`) and the relay
 *   (`sendBinary`); inbound packets from either path feed `onBytes`.
 */
import type { Core, FrameInputs } from "../core/types";
import { createLockstep, type Lockstep } from "./lockstep";
import { createSession, type NetplaySession } from "./session";
import type { NetplayConfig, RtcFactory, WebSocketFactory } from "./types";

export type MatchStatus =
  | "connecting"
  | "waiting-for-peers"
  | "running"
  | "waiting";

export interface MatchDeps {
  core: Core;
  config: NetplayConfig;
  socketFactory: WebSocketFactory;
  factory: RtcFactory;
  /** Milliseconds clock, passed through to the lockstep wait timer. */
  now: () => number;
  /** Local input delay D (docs/03: 2-3); default 2. */
  inputDelay?: number;
  /** First frame to simulate; default 0. */
  startFrame?: number;
  onStatus?: (status: MatchStatus) => void;
}

export interface NetplayMatch {
  /** One animation tick; a no-op until `game.start` arrives. */
  tick(localInputs: FrameInputs): void;
  /** Next frame to simulate, or `startFrame` before the match starts. */
  frame(): number;
  status(): MatchStatus;
  /** The underlying session (exposed for the play page / status UI). */
  session(): NetplaySession;
  close(): void;
}

const DEFAULT_INPUT_DELAY = 2;

export function createMatch(deps: MatchDeps): NetplayMatch {
  const inputDelay = deps.inputDelay ?? DEFAULT_INPUT_DELAY;
  const startFrame = deps.startFrame ?? 0;

  let lockstep: Lockstep | null = null;
  let coreReady = false;
  let closed = false;
  let status: MatchStatus = "connecting";
  let self: number | null = null;
  let pendingStart: { startFrame: number; inputDelay: number } | null = null;
  const roster: number[] = [];

  function setStatus(next: MatchStatus): void {
    if (status === next) return;
    status = next;
    deps.onStatus?.(next);
  }

  function startLockstep(frame: number, delay: number): void {
    if (lockstep || closed || self === null) return;
    const players = roster.length > 0 ? [...roster] : [self];
    lockstep = createLockstep({
      core: deps.core,
      mySlot: self,
      players,
      inputDelay: delay,
      startFrame: frame,
      sendInput: (packet) => {
        const buffer = packet.buffer as ArrayBuffer;
        session.broadcast(buffer);
        session.sendBinary(buffer);
      },
      now: deps.now,
      onStatus: setStatus,
    });
    setStatus("running");
  }

  function tryHostStart(): void {
    if (closed || lockstep || !coreReady || self === null) return;
    const host = roster.length > 0 ? Math.min(...roster) : self;
    if (self !== host || !session.ready()) return;
    session.send({ t: "game.start", startFrame, inputDelay });
  }

  const session = createSession({
    config: deps.config,
    socketFactory: deps.socketFactory,
    factory: deps.factory,
    onRoomState: (message) => {
      self = message.self;
      roster.splice(0, roster.length, ...message.players.map((p) => p.slot));
      if (!lockstep) setStatus("waiting-for-peers");
      if (pendingStart && self !== null) {
        const { startFrame: frame, inputDelay: delay } = pendingStart;
        pendingStart = null;
        startLockstep(frame, delay);
      }
      tryHostStart();
    },
    onGameStart: (message) => {
      // A start can outrace the first `room.state`; hold it until we know our
      // slot and the roster.
      if (self === null) {
        pendingStart = { startFrame: message.startFrame, inputDelay: message.inputDelay };
        return;
      }
      startLockstep(message.startFrame, message.inputDelay);
    },
    onInput: (bytes) => lockstep?.onBytes(bytes),
    onChannelOpen: () => tryHostStart(),
  });

  void deps.core
    .load()
    .then(() => {
      coreReady = true;
      tryHostStart();
    })
    .catch(() => {
      // A boot failure is surfaced by the play page's own load handling.
    });

  return {
    tick: (localInputs) => lockstep?.tick(localInputs),
    frame: () => (lockstep ? lockstep.frame() : startFrame),
    status: () => status,
    session: () => session,
    close: () => {
      closed = true;
      lockstep = null;
      session.close();
    },
  };
}
