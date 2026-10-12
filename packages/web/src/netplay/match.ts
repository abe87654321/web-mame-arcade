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
import { decodeInput, type PlayerPause, type RoomState } from "@wma/protocol";
import type { Core } from "../core/types";
import { selectInputDelay } from "./delay";
import { createLockstep, type Lockstep } from "./lockstep";
import { createMetrics, type Metrics, type MetricsSnapshot } from "./metrics";
import { createSession, type NetplaySession } from "./session";
import { createScoreboard, isSampleDue, type ScoreRow } from "./scoreboard";
import type { NetplayConfig, RtcFactory, WebSocketFactory } from "./types";
import type { VideoPublisher } from "./video";
export type MatchStatus =
  | "connecting"
  | "waiting-for-peers"
  | "running"
  | "waiting"
  | "paused";

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
  /** The host is sharing A/V via LiveKit (T41). */
  video: boolean;
  /** The match is collaboratively paused (T29): any player paused the room. */
  paused: boolean;
}

/** Match identity the host announces with `game.set` (T30). */
export interface MatchGame {
  driver: string;
  coreHash: string;
  mameCommit: string;
  romHash: string;
  dips: Record<string, string | number>;
}

export interface MatchDeps {
  core: Core;
  config: NetplayConfig;
  socketFactory: WebSocketFactory;
  factory: RtcFactory;
  /**
   * Game identity for `game.set`/input logging (T30); when absent the match
   * runs without a relay input log (e.g. tests, or a room with no game).
   */
  game?: MatchGame;
  /** Milliseconds clock, passed through to the lockstep wait timer. */
  now: () => number;
  /** Local input delay D (docs/03: 2-3); default 2. */
  inputDelay?: number;
  /** First frame to simulate; default 0. */
  startFrame?: number;
  onStatus?: (status: MatchStatus) => void;
  /** Lobby snapshot on every room.state / ready / peer / status change (T27). */
  onLobby?: (state: LobbyState) => void;
  /**
   * Live per-slot scores on every change (T32); display only. Emitted from our
   * own samples and from peers' `score.live`.
   */
  onScores?: (rows: ScoreRow[]) => void;
  /** Milliseconds between our own score samples; default 1000 (T32). */
  scoreIntervalMs?: number;
  /** Hash every this many frames; default 60 (T25, docs/03). */
  hashInterval?: number;
  /**
   * Escalate a persisting stall to a host `state.snapshot` after this many ms
   * (T29 mutual-stall recovery); default 6000.
   */
  stallEscalateMs?: number;
  /**
   * Publish a live-join snapshot for viewers every this many ms (T31);
   * default 5000. Host-only, wall-clock paced (never part of the emulation).
   */
  snapshotIntervalMs?: number;
  /**
   * Periodic connection metrics for the dev overlay (T28): per-peer
   * RTT/jitter/loss and the P2P-vs-relay tally. Telemetry only — the clock
   * never reaches `core.step`; emitted at most every `metricsIntervalMs`.
   */
  onMetrics?: (snapshot: MetricsSnapshot) => void;
  /** Minimum gap between metrics emissions, ms; default 250 (T28). */
  metricsIntervalMs?: number;
  /**
   * Upload a save state and return a fetchable URL (T25). Defaults to POSTing
   * to the relay's in-memory snapshot endpoint derived from `relayUrl`.
   */
  createSnapshot?: (state: Uint8Array) => Promise<string>;
  /** Fetch a snapshot blob by URL (T25). Defaults to `fetch(url)`. */
  fetchSnapshot?: (blobUrl: string) => Promise<Uint8Array>;
  /** Optional structured log sink for desync/resync events (T25). */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /**
   * Deterministic scripted input for the e2e harness (T26). When present,
   * `tick` schedules `inputScript(ourSlot, scheduledFrame)` instead of the
   * wall-clock-sampled mask, so a frame's input never depends on tick timing.
   * Inert in production: only the e2e hook sets it.
   */
  inputScript?: (slot: number, frame: number) => number;
  /**
   * Host-side A/V publisher (T41): started when this client is the host and the
   * relay hands it LiveKit credentials, stopped on `video.set{enabled:false}`.
   */
  video?: VideoPublisher;
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
  /**
   * Toggle this client's collaborative pause (T29); false when the match has
   * not started. The relay aggregates it with other players' pauses.
   */
  setPaused(paused: boolean): boolean;
  /** Host toggles the LiveKit A/V fallback; false for a non-host (T41). */
  setVideo(enabled: boolean): boolean;
  /** The current lobby snapshot. */
  lobby(): LobbyState;
  /** The current connection metrics, or null before the match starts (T28). */
  metrics(): MetricsSnapshot | null;
  /** Latest live score per reported slot, ascending (T32). */
  scores(): ScoreRow[];
  /** The underlying session (exposed for the play page / status UI). */
  session(): NetplaySession;
  close(): void;
}

interface RosterEntry {
  slot: number;
  name: string;
  ready: boolean;
}

const DEFAULT_SNAPSHOT_INTERVAL_MS = 5000;
/** Minimum gap between `input.request` resends while stalled (T31). */
const RESYNC_INTERVAL_MS = 1000;
/** Minimum gap between dev-overlay metrics emissions (T28). */
const DEFAULT_METRICS_INTERVAL_MS = 250;
/** Milliseconds between a player's own live-score samples (T32). */
const DEFAULT_SCORE_INTERVAL_MS = 1000;

/** Derive the relay HTTP origin from its WebSocket URL (`ws(s)://`→`http(s)://`). */
function httpBase(relayUrl: string): string {
  try {
    const url = new URL(relayUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = url.pathname.replace(/\/ws$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return relayUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
  }
}

export function createMatch(deps: MatchDeps): NetplayMatch {
  const startFrame = deps.startFrame ?? 0;
  const snapshotIntervalMs = deps.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const metricsIntervalMs = deps.metricsIntervalMs ?? DEFAULT_METRICS_INTERVAL_MS;
  const scoreIntervalMs = deps.scoreIntervalMs ?? DEFAULT_SCORE_INTERVAL_MS;
  const log = deps.log;
  const inputScript = deps.inputScript;
  const createSnapshot =
    deps.createSnapshot ??
    (async (state: Uint8Array): Promise<string> => {
      const url = `${httpBase(deps.config.relayUrl)}/rooms/${encodeURIComponent(deps.config.room)}/snapshot`;
      const response = await fetch(url, {
        method: "POST",
        body: state as unknown as BodyInit,
      });
      const body = (await response.json()) as { url: string };
      return body.url;
    });
  const fetchSnapshot =
    deps.fetchSnapshot ??
    (async (blobUrl: string): Promise<Uint8Array> => {
      const response = await fetch(blobUrl);
      return new Uint8Array(await response.arrayBuffer());
    });

  let lockstep: Lockstep | null = null;
  let coreReady = false;
  let closed = false;
  let disconnected = false;
  let status: MatchStatus = "connecting";
  let self: number | null = null;
  let roomStatus: RoomState["status"] = "waiting";
  let pendingStart: { startFrame: number; inputDelay: number } | null = null;
  let startSent = false;
  let gameSetSent = false;
  /** Whether the host is sharing A/V (T41); mirrors the relay's `video.set`. */
  let videoEnabled = false;
  /** Last wall-clock live-join snapshot; null until the cadence is armed (T31). */
  let lastViewerSnapshotAt: number | null = null;
  let viewerSnapshotInFlight = false;
  /** Last time we asked the relay to resend inputs after a stall (T31). */
  let lastResyncAt = 0;
  /** Connection telemetry, armed with the lockstep (T28). */
  let metrics: Metrics | null = null;
  let lastMetricsAt: number | null = null;
  /** Per-peer lobby RTT (ms) measured for the adaptive input delay (T29). */
  let measuredRtts: Record<number, number> = {};
  /** Our own pause intent (tab hidden), and the relay's aggregate (T29). */
  let localPaused = false;
  let relayPaused = false;
  /** The effective pause: either our own intent or another player's. */
  let paused = false;
  /** Highest snapshot frame applied, so an out-of-order fetch cannot rewind us (T29). */
  let lastAppliedSnapshotFrame = -1;
  /** Live per-slot scores (T32); cleared on a fresh match. */
  const scoreboard = createScoreboard();
  /** Last wall-clock score sample; null until the cadence is armed (T32). */
  let lastScoreAt: number | null = null;
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

  /**
   * The host announces the game + DIPs once, before the match starts, so the
   * relay can fill `room.state` and open an input log (T30). Non-hosts and
   * rooms without a configured game skip it.
   */
  function maybeSetGame(): void {
    if (
      gameSetSent ||
      !deps.game ||
      closed ||
      disconnected ||
      self === null ||
      !coreReady ||
      roomStatus !== "waiting" ||
      !isHost()
    ) {
      return;
    }
    if (
      session.send({
        t: "game.set",
        driver: deps.game.driver,
        coreHash: deps.game.coreHash,
        mameCommit: deps.game.mameCommit,
        romHash: deps.game.romHash,
        dips: deps.game.dips,
      })
    ) {
      gameSetSent = true;
    }
  }

  /**
   * Recompute the effective pause (our own intent OR the relay's aggregate of
   * other players) and drive the lockstep + status from it (T29). Pausing only
   * gates `core.step`; it never enters the emulation path.
   */
  function applyPause(): void {
    const next = localPaused || relayPaused;
    if (next === paused) return;
    paused = next;
    if (paused) {
      lockstep?.pause();
      if (lockstep) setStatus("paused");
    } else {
      lockstep?.resume();
      if (lockstep) setStatus("running");
    }
    emitLobby();
  }

  /**
   * Measure the lobby RTT to every peer once, while hosting before the start,
   * to size the adaptive input delay (T29). Best-effort: a missing/failed stat
   * leaves the delay at its floor.
   */
  function measurePeers(): void {
    if (
      closed ||
      disconnected ||
      self === null ||
      !isHost() ||
      startSent ||
      lockstep
    ) {
      return;
    }
    void session
      .peerRtts()
      .then((rtts) => {
        measuredRtts = rtts;
      })
      .catch(() => {
        // Telemetry only; a failed getStats must not disturb the lobby.
      });
  }

  function lobby(): LobbyState {
    const host = hostSlot();
    return {
      roomStatus: disconnected ? "disconnected" : roomStatus,
      isHost: isHost(),
      canStart: canStart(),
      video: videoEnabled,
      paused,
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
    // A fresh match starts unpaused as far as the relay is concerned. Our own
    // `localPaused` persists across the lobby→play boundary: a tab hidden
    // before the start must still pause the room once it begins (T29).
    paused = false;
    relayPaused = false;
    lastAppliedSnapshotFrame = -1;
    // A fresh match starts with no live scores (T32).
    scoreboard.clear();
    lastScoreAt = null;
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
      hash: () => deps.core.hash(),
      ...(deps.hashInterval !== undefined ? { hashInterval: deps.hashInterval } : {}),
      ...(deps.stallEscalateMs !== undefined
        ? { stallEscalateMs: deps.stallEscalateMs }
        : {}),
      onHash: (frame, crc32) => {
        // Relay-ward only: it compares per frame across players and broadcasts
        // `desync` on a genuine mismatch (T25, docs/03).
        session.send({ t: "hash", frame, crc32 });
      },
      onStall: (frame) => {
        // A late input past the 8-frame redundancy window would stall forever;
        // ask the relay to resend the recorded inputs from here (T31 recovery).
        const at = deps.now();
        if (at - lastResyncAt < RESYNC_INTERVAL_MS) return;
        lastResyncAt = at;
        session.send({ t: "input.request", fromFrame: frame });
        log?.("resync-request", { frame });
      },
      onStallEscalate: (frame) => {
        // Mutual-stall recovery (T29): a resend never arrived, so both peers are
        // stuck on `frame`. The host falls back to a full snapshot at its last
        // stepped frame so everyone resynchronizes from one authority. Never
        // escalate an intentional pause.
        if (paused) return;
        log?.("stall-escalate", { frame });
        sendRecoverySnapshot(frame - 1, "stall-escalate");
      },
    });
    metrics = createMetrics({ mySlot: self, players, now: deps.now });
    lastMetricsAt = null;
    if (localPaused) {
      // The tab was hidden before the start: hold the fresh lockstep paused and
      // tell the relay, so the throttled tab does not stall the other peers.
      lockstep.pause();
      setStatus("paused");
      session.send({ t: "player.pause", paused: true });
    } else {
      setStatus("running");
    }
  }

  /**
   * Host-only recovery: save the current state, publish it as `state.snapshot`
   * and drop our own stale staged inputs (T25 desync / T29 mutual-stall
   * escalation). The snapshot is labelled with the host's own last stepped
   * frame, not the relay's (older, latency-delayed) frame.
   */
  function sendRecoverySnapshot(frame: number, reason: string): void {
    if (!isHost() || !lockstep || frame < 0) return;
    let state: Uint8Array;
    try {
      state = deps.core.save();
    } catch (error) {
      log?.("resync-error", { frame, error: String(error) });
      return;
    }
    const active = lockstep;
    void createSnapshot(state)
      .then((blobUrl) => {
        session.send({ t: "state.snapshot", frame, blobUrl });
        // Clear our own input window too: we still hold the desynced peer's
        // pre-snapshot masks for frames > `frame`, and first-wins would reject
        // its corrected masks, re-diverging immediately.
        active.resync(frame);
        log?.("resync-sent", { frame, reason });
      })
      .catch((error) => log?.("resync-error", { frame, error: String(error) }));
  }

  /** Emit a throttled metrics snapshot for the dev overlay (T28). */
  function emitMetrics(now: number): void {
    if (!metrics || !deps.onMetrics) return;
    if (lastMetricsAt !== null && now - lastMetricsAt < metricsIntervalMs) return;
    lastMetricsAt = now;
    try {
      deps.onMetrics(metrics.snapshot(lockstep ? lockstep.frame() : 0));
    } catch {
      // Telemetry must never break the animation loop: a dev-overlay render
      // error is swallowed here rather than unwinding through `tick`.
    }
  }

  function maybeStartPending(): void {
    if (pendingStart && self !== null && coreReady) {
      const { startFrame: frame, inputDelay: delay } = pendingStart;
      pendingStart = null;
      startLockstep(frame, delay);
    }
  }

  /**
   * Publish the host's live-join snapshot for viewers (T31). Host-only, once
   * per `snapshotIntervalMs`, while a logged match is running. Wall-clock paced
   * (it never touches the emulation), one in flight at a time. Non-hosts and
   * rooms without `game.set` skip it (the relay has no live-join log to match).
   */
  function maybeViewerSnapshot(now: number): void {
    if (
      viewerSnapshotInFlight ||
      !lockstep ||
      closed ||
      disconnected ||
      self === null ||
      !gameSetSent ||
      !isHost()
    ) {
      return;
    }
    const frame = lockstep.frame() - 1;
    if (frame < 0) return;
    if (lastViewerSnapshotAt === null) {
      lastViewerSnapshotAt = now; // arm the cadence; publish after one interval
      return;
    }
    if (now - lastViewerSnapshotAt < snapshotIntervalMs) return;
    lastViewerSnapshotAt = now;
    let state: Uint8Array;
    try {
      state = deps.core.save();
    } catch (error) {
      log?.("viewer-snapshot-error", { frame, error: String(error) });
      return;
    }
    viewerSnapshotInFlight = true;
    void createSnapshot(state)
      .then((blobUrl) => {
        session.send({ t: "viewer.snapshot", frame, blobUrl });
        log?.("viewer-snapshot", { frame });
      })
      .catch((error: unknown) =>
        log?.("viewer-snapshot-error", { frame, error: String(error) }),
      )
      .finally(() => {
        viewerSnapshotInFlight = false;
      });
  }

  /**
   * Sample our own slot's live score at most once per `scoreIntervalMs` and
   * send `score.live` (T32). Display only: reading memory never mutates the
   * machine and the wall clock only paces the message, never `core.step`. A
   * core without the scoremap (stock build / T32b pending) throws
   * `CoreCapabilityError`, which is swallowed. Only logged matches report.
   */
  function maybeSampleScore(now: number): void {
    if (
      !lockstep ||
      closed ||
      disconnected ||
      self === null ||
      !gameSetSent ||
      paused ||
      !isSampleDue(now, lastScoreAt, scoreIntervalMs)
    ) {
      return;
    }
    lastScoreAt = now;
    const frame = lockstep.frame() - 1;
    if (frame < 0) return;
    let score: number;
    try {
      score = deps.core.readScore(self);
    } catch {
      return;
    }
    if (!Number.isFinite(score)) return;
    if (session.send({ t: "score.live", score, frame })) {
      scoreboard.set(self, score);
      deps.onScores?.(scoreboard.rows());
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
      maybeSetGame();
      measurePeers();
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
    onPlayerPause: (message: PlayerPause) => {
      // The relay's aggregate: pause/resume our lockstep to match the room
      // (T29). Our own intent is tracked separately so a peer's resume cannot
      // unpause us while our tab is still hidden (applyPause ORs the two).
      relayPaused = message.paused;
      applyPause();
    },
    onScoreLive: (message) => {
      // A peer's (or the relay's echo of our own) live score (T32): display only.
      if (message.player === undefined) return;
      scoreboard.set(message.player, message.score);
      deps.onScores?.(scoreboard.rows());
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
    onInput: (bytes, source) => {
      if (metrics) {
        try {
          const packet = decodeInput(bytes);
          metrics.onPeerPacket(packet.player, packet, source, deps.now());
        } catch {
          // Malformed/foreign packets are dropped by the lockstep too.
        }
      }
      lockstep?.onBytes(bytes);
    },
    onDesync: (message) => {
      // Only the host can answer; peers wait for its snapshot (docs/03). The
      // snapshot must be labelled with the host's *current* position at save
      // time, not the (older, latency-delayed) frame the relay flagged: the
      // host keeps ticking between sending a hash and hearing `desync`.
      if (!isHost() || !lockstep) return;
      const frame = lockstep.frame() - 1;
      if (frame < 0) return;
      log?.("desync", { frame: message.frame, snapshotFrame: frame });
      sendRecoverySnapshot(frame, "desync");
    },
    onStateSnapshot: (message) => {
      void fetchSnapshot(message.blobUrl)
        .then((bytes) => {
          // Snapshots can be in flight at once (desync + escalation intervals);
          // a slower fetch of an older frame must not clobber a newer state.
          if (message.frame <= lastAppliedSnapshotFrame) {
            log?.("resync-stale", { frame: message.frame, applied: lastAppliedSnapshotFrame });
            return;
          }
          deps.core.load(bytes, message.frame);
          lockstep?.resync(message.frame);
          lastAppliedSnapshotFrame = message.frame;
          log?.("resync-applied", { frame: message.frame });
        })
        .catch((error) => log?.("resync-error", { frame: message.frame, error: String(error) }));
    },
    onVideoSet: (message) => {
      // The relay fanned out the host's A/V toggle (T41). Reflect it in the
      // lobby; if it was turned off, stop our publisher if we were the host.
      videoEnabled = message.enabled;
      if (!message.enabled) deps.video?.stop();
      emitLobby();
    },
    onLivekitAccess: (message) => {
      // Credentials are per member; only the host publishes canvas + audio.
      if (isHost() && deps.video) {
        void deps.video.start(message.url, message.token);
      }
    },
    // A start may have arrived while the core/channel was still coming up.
    onChannelOpen: () => {
      maybeSetGame();
      measurePeers();
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
      maybeSetGame();
      maybeStartPending();
      emitLobby();
    })
    .catch(() => {
      // A boot failure is surfaced by the play page's own load handling.
    });

  return {
    tick: (localMask) => {
      if (!lockstep) return;
      const now = deps.now();
      // Record when our own frame is scheduled so a later peer ack yields RTT.
      metrics?.noteLocalFrame(lockstep.scheduledFrame(), now);
      // The e2e harness (T26) supplies a deterministic per-slot mask keyed on
      // the frame being scheduled, so the input a frame receives is independent
      // of when this animation tick fired.
      if (inputScript && self !== null) {
        lockstep.tick(inputScript(self, lockstep.scheduledFrame()));
      } else {
        lockstep.tick(localMask);
      }
      maybeViewerSnapshot(now);
      maybeSampleScore(now);
      emitMetrics(now);
    },
    frame: () => (lockstep ? lockstep.frame() : startFrame),
    status: () => status,
    isHost,
    canStart,
    start: () => {
      if (!canStart()) return false;
      // The host sizes D from the lobby RTTs it measured (T29); an explicit
      // `deps.inputDelay` (tests/e2e) overrides it. Every peer steps the agreed
      // value carried by `game.start`, so this stays deterministic.
      const delay =
        deps.inputDelay ?? selectInputDelay(Object.values(measuredRtts));
      if (!session.send({ t: "game.start", startFrame, inputDelay: delay })) {
        return false;
      }
      startSent = true;
      emitLobby();
      return true;
    },
    setReady: (ready) => {
      if (closed || disconnected || self === null) return false;
      return session.send({ t: "player.ready", ready });
    },
    setPaused: (nextPaused) => {
      if (closed || disconnected) return false;
      // Record the intent even before the match starts; `startLockstep` honours
      // it so a tab hidden in the lobby pauses the room once it begins (T29).
      localPaused = nextPaused;
      applyPause();
      if (!lockstep) return false;
      return session.send({ t: "player.pause", paused: nextPaused });
    },
    setVideo: (enabled) => {
      if (closed || disconnected || self === null || !isHost()) return false;
      return session.send({ t: "video.set", enabled });
    },
    lobby,
    metrics: () => (metrics ? metrics.snapshot(lockstep ? lockstep.frame() : 0) : null),
    scores: () => scoreboard.rows(),
    session: () => session,
    close: () => {
      // The host closes the relay input log on teardown of a playing match; the
      // last stepped frame is one before the next to step (T30).
      if (lockstep && gameSetSent && isHost()) {
        const lastFrame = lockstep.frame() - 1;
        if (lastFrame >= 0) session.send({ t: "game.end", frame: lastFrame });
      }
      closed = true;
      lockstep = null;
      metrics = null;
      videoEnabled = false;
      paused = false;
      localPaused = false;
      relayPaused = false;
      scoreboard.clear();
      deps.video?.stop();
      session.close();
    },
  };
}
