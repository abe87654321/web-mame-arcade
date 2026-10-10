/**
 * Netplay match orchestrator (T24, lobby T27). Owns the session and the
 * lockstep loop and connects them to one `Core`:
 *
 * - `room.state` → the roster (slot/name/ready), our own slot and room status.
 *   The lowest-slot host may then call `start()` (the lobby "Start game"
 *   button) once every peer's data channel is open and every other player has
 *   toggled ready, which sends `game.start`. Starting is manual so the first
 *   player in a room does not lock out friends who join moments later.
 * - `player.ready` → the relay-stamped toggle; the lobby re-renders.
 * - `game.start` (fanned out by the relay) → every peer starts its lockstep at
 *   the agreed `startFrame`/`inputDelay`.
 * - lockstep packets go out over the data channels (`broadcast`) and the relay
 *   (`sendBinary`); inbound packets from either path feed `onBytes`.
 */
import type { RoomState } from "@wma/protocol";
import type { Core } from "../core/types";
import { createLockstep, type Lockstep } from "./lockstep";
import { createSession, type NetplaySession } from "./session";
import type { NetplayConfig, RtcFactory, WebSocketFactory } from "./types";

export type MatchStatus =
  | "connecting"
  | "waiting-for-peers"
  | "running"
  | "waiting";

/** A player row in the lobby snapshot. */
export interface LobbyPlayer {
  slot: number;
  name: string;
  /** This slot is the room host (lowest occupied player slot). */
  host: boolean;
  /** This slot is us (`self`). */
  self: boolean;
  /** Our data channel to this slot is open (always true for our own slot). */
  connected: boolean;
  /** The player has toggled ready. */
  ready: boolean;
}

/** Everything the lobby view renders; emitted via `onLobby` on every change. */
export interface LobbyState {
  /** Room lifecycle, or `"disconnected"` after our relay socket closed. */
  roomStatus: RoomState["status"] | "disconnected";
  players: LobbyPlayer[];
  isHost: boolean;
  /** `start()` would succeed now: host, booted, peers connected, others ready. */
  canStart: boolean;
}

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
  /** Lobby snapshot on every room.state / ready / peer / status change (T27). */
  onLobby?: (state: LobbyState) => void;
}

export interface NetplayMatch {
  /** One animation tick with this browser's own input mask; no-op before start. */
  tick(localMask: number): void;
  /** Next frame to simulate, or `startFrame` before the match starts. */
  frame(): number;
  status(): MatchStatus;
  /** True when this client is the lowest-slot host of the room. */
  isHost(): boolean;
  /** True when `start()` would succeed (host, booted, peers connected + ready). */
  canStart(): boolean;
  /** Host starts the game; false when not host/not ready/already started. */
  start(): boolean;
  /** Toggle our own lobby ready flag; false when we are not a seated player. */
  setReady(ready: boolean): boolean;
  /** The current lobby snapshot. */
  lobby(): LobbyState;
  /** The underlying session (exposed for the play page / status UI). */
  session(): NetplaySession;
  close(): void;
}

interface RosterEntry {
  slot: number;
  name: string;
  ready: boolean;
}

const DEFAULT_INPUT_DELAY = 2;

export function createMatch(deps: MatchDeps): NetplayMatch {
  const inputDelay = deps.inputDelay ?? DEFAULT_INPUT_DELAY;
  const startFrame = deps.startFrame ?? 0;

  let lockstep: Lockstep | null = null;
  let coreReady = false;
  let closed = false;
  let disconnected = false;
  let status: MatchStatus = "connecting";
  let self: number | null = null;
  let roomStatus: RoomState["status"] = "waiting";
  let pendingStart: { startFrame: number; inputDelay: number } | null = null;
  let startSent = false;
  const roster: RosterEntry[] = [];

  function setStatus(next: MatchStatus): void {
    if (status === next) return;
    status = next;
    deps.onStatus?.(next);
    emitLobby();
  }

  function hostSlot(): number | null {
    if (roster.length > 0) return Math.min(...roster.map((p) => p.slot));
    return self;
  }

  function isHost(): boolean {
    const host = hostSlot();
    return self !== null && host !== null && self === host;
  }

  /** Our channel to `slot` is usable; our own slot is always connected. */
  function connected(slot: number): boolean {
    if (slot === self) return self !== null;
    return session.peerOpen(slot);
  }

  function othersReady(): boolean {
    return roster
      .filter((p) => p.slot !== self)
      .every((p) => connected(p.slot) && p.ready);
  }

  function canStart(): boolean {
    return (
      !closed &&
      !disconnected &&
      !startSent &&
      !lockstep &&
      coreReady &&
      self !== null &&
      isHost() &&
      othersReady()
    );
  }

  function lobby(): LobbyState {
    const host = hostSlot();
    return {
      roomStatus: disconnected ? "disconnected" : roomStatus,
      isHost: isHost(),
      canStart: canStart(),
      players: roster.map((p) => ({
        slot: p.slot,
        name: p.name,
        host: p.slot === host,
        self: p.slot === self,
        connected: connected(p.slot),
        ready: p.ready,
      })),
    };
  }

  function emitLobby(): void {
    deps.onLobby?.(lobby());
  }

  function startLockstep(frame: number, delay: number): void {
    // Never step before the core has booted: frame 0 must be the same machine
    // state on every peer (AGENTS.md determinism rule).
    if (lockstep || closed || self === null || !coreReady) return;
    const players = roster.length > 0 ? roster.map((p) => p.slot) : [self];
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

  function maybeStartPending(): void {
    if (pendingStart && self !== null && coreReady) {
      const { startFrame: frame, inputDelay: delay } = pendingStart;
      pendingStart = null;
      startLockstep(frame, delay);
    }
  }

  const session = createSession({
    config: deps.config,
    socketFactory: deps.socketFactory,
    factory: deps.factory,
    onRoomState: (message) => {
      self = message.self;
      roomStatus = message.status;
      roster.splice(
        0,
        roster.length,
        ...message.players.map((p) => ({ slot: p.slot, name: p.name, ready: p.ready })),
      );
      if (!lockstep) setStatus("waiting-for-peers");
      maybeStartPending();
      emitLobby();
    },
    onPlayerReady: (message) => {
      // Apply the toggle optimistically so the lobby reacts immediately; the
      // relay's follow-up room.state is authoritative and re-syncs the roster.
      if (message.player !== undefined) {
        const entry = roster.find((p) => p.slot === message.player);
        if (entry) entry.ready = message.ready;
      }
      emitLobby();
    },
    onGameStart: (message) => {
      // A start can outrace the first `room.state` or the core boot; hold it
      // until we know our slot and can step.
      if (self === null || !coreReady) {
        pendingStart = { startFrame: message.startFrame, inputDelay: message.inputDelay };
        return;
      }
      startLockstep(message.startFrame, message.inputDelay);
    },
    onInput: (bytes) => lockstep?.onBytes(bytes),
    // A start may have arrived while the core/channel was still coming up.
    onChannelOpen: () => {
      maybeStartPending();
      emitLobby();
    },
    onPeersChanged: () => emitLobby(),
    onClose: () => {
      disconnected = true;
      emitLobby();
    },
  });

  void deps.core
    .load()
    .then(() => {
      coreReady = true;
      maybeStartPending();
      emitLobby();
    })
    .catch(() => {
      // A boot failure is surfaced by the play page's own load handling.
    });

  return {
    tick: (localMask) => lockstep?.tick(localMask),
    frame: () => (lockstep ? lockstep.frame() : startFrame),
    status: () => status,
    isHost,
    canStart,
    start: () => {
      if (!canStart()) return false;
      if (!session.send({ t: "game.start", startFrame, inputDelay })) return false;
      startSent = true;
      emitLobby();
      return true;
    },
    setReady: (ready) => {
      if (closed || disconnected || self === null) return false;
      return session.send({ t: "player.ready", ready });
    },
    lobby,
    session: () => session,
    close: () => {
      closed = true;
      lockstep = null;
      session.close();
    },
  };
}
