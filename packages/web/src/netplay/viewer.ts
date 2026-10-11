/**
 * Live viewer controller (T31). Unlike a player, a viewer runs no RTC mesh and
 * sends nothing: it joins the relay as a viewer, receives the match handshake
 * (`viewer.state`), loads the host's live-join snapshot (or boots at the start),
 * then replays the relayed input stream through a frozen core a fixed buffer
 * behind live (docs/04).
 *
 * The controller owns no clock of its own: the caller drives `tick(now)` per
 * animation frame, and only the inputs the relay recorded ever reach the core,
 * so the replay is deterministic (AGENTS.md determinism rule).
 */
import type { RoomState, ServerMessage, ViewerSnapshot, ViewerState } from "@wma/protocol";
import type { Core } from "../core/types";
import { createPlayback, type Playback } from "./playback";
import { createRelayClient, type RelayClient } from "./relay-client";
import type { WebSocketFactory } from "./types";
import type { VideoSubscriber } from "./video";

export type ViewerStatus =
  | "connecting"
  | "buffering"
  | "playing"
  | "ended"
  | "disconnected";

export interface ViewerPlayer {
  slot: number;
  name: string;
}

export interface ViewerDeps {
  /** The frozen core the app already booted (`netplay: true`). */
  core: Core;
  config: { relayUrl: string; token: string; room: string };
  socketFactory: WebSocketFactory;
  /** Wall clock for the buffer cadence. */
  now: () => number;
  /** Playback buffer in ms (docs/04: 2000-5000); default 3000. */
  bufferMs?: number;
  /** Emulated frame duration in ms; default 1000/60. */
  frameMs?: number;
  /** Fetch a snapshot blob; default `fetch(url)` as an ArrayBuffer. */
  fetchSnapshot?: (blobUrl: string) => Promise<Uint8Array>;
  onStatus?: (status: ViewerStatus) => void;
  onPlayers?: (players: ViewerPlayer[]) => void;
  /**
   * A/V subscriber (T41): when the host shares video the relay hands this
   * viewer LiveKit credentials and `onVideo` receives the remote stream (or
   * null when it ends/the host stops). Display-only.
   */
  video?: VideoSubscriber;
  onVideo?: (stream: MediaStream | null) => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface Viewer {
  /** Step this frame's due inputs; call once per animation frame. */
  tick(now: number): void;
  /** The next frame the viewer will step. */
  frame(): number;
  status(): ViewerStatus;
  players(): ViewerPlayer[];
  close(): void;
}

const DEFAULT_BUFFER_MS = 3000;
const DEFAULT_FRAME_MS = 1000 / 60;

export function createViewer(deps: ViewerDeps): Viewer {
  const bufferMs = deps.bufferMs ?? DEFAULT_BUFFER_MS;
  const frameMs = deps.frameMs ?? DEFAULT_FRAME_MS;
  const fetchSnapshot =
    deps.fetchSnapshot ??
    (async (blobUrl: string): Promise<Uint8Array> => {
      const response = await fetch(blobUrl);
      return new Uint8Array(await response.arrayBuffer());
    });

  let status: ViewerStatus = "connecting";
  let players: ViewerPlayer[] = [];
  let playback: Playback | null = null;
  let closed = false;
  // Binary frames that arrived before the playback existed: the relay sends the
  // viewer.state handshake and the catch-up frames back-to-back, but a snapshot
  // load is async, so without this buffer the whole catch-up would be dropped.
  const pending: Uint8Array[] = [];

  function setStatus(next: ViewerStatus): void {
    if (status === next) return;
    status = next;
    deps.onStatus?.(next);
  }

  function startPlayback(startFrame: number): void {
    playback = createPlayback({
      players: players.map((player) => player.slot),
      startFrame,
      bufferMs,
      frameMs,
    });
    for (const bytes of pending) playback.onBytes(bytes);
    pending.length = 0;
    setStatus("buffering");
  }

  function applyViewerState(message: ViewerState): void {
    players = message.players.map((player) => ({ ...player }));
    deps.onPlayers?.(players);
    if (playback) return; // already watching; a re-send is just a refresh
    const snapshot = message.snapshot;
    if (!snapshot) {
      startPlayback(message.startFrame);
      return;
    }
    void fetchSnapshot(snapshot.blobUrl)
      .then((bytes) => {
        if (closed) return;
        deps.core.load(bytes, snapshot.frame);
        startPlayback(snapshot.frame + 1);
        deps.log?.("viewer-snapshot", { frame: snapshot.frame });
      })
      .catch((error: unknown) => {
        deps.log?.("viewer-snapshot-error", { error: String(error) });
      });
  }

  function applyViewerSnapshot(message: ViewerSnapshot): void {
    // A later snapshot only helps a viewer that has not started yet.
    if (playback) return;
    void fetchSnapshot(message.blobUrl)
      .then((bytes) => {
        if (closed || playback) return;
        deps.core.load(bytes, message.frame);
        startPlayback(message.frame + 1);
        deps.log?.("viewer-snapshot", { frame: message.frame });
      })
      .catch((error: unknown) => {
        deps.log?.("viewer-snapshot-error", { error: String(error) });
      });
  }

  function applyRoomState(message: RoomState): void {
    if (status === "ended" || status === "disconnected") return;
    if (message.status === "ended") setStatus("ended");
  }

  const client: RelayClient = createRelayClient({
    url: deps.config.relayUrl,
    join: { room: deps.config.room, role: "viewer", token: deps.config.token },
    socketFactory: deps.socketFactory,
    onMessage: (message: ServerMessage) => {
      switch (message.t) {
        case "viewer.state":
          applyViewerState(message);
          return;
        case "viewer.snapshot":
          applyViewerSnapshot(message);
          return;
        case "room.state":
          applyRoomState(message);
          return;
        case "livekit.access":
          // The relay handed us LiveKit credentials for the host's A/V (T41).
          void deps.video?.start(message.url, message.token, (stream) =>
            deps.onVideo?.(stream),
          );
          return;
        case "video.set":
          if (!message.enabled) {
            deps.video?.stop();
            deps.onVideo?.(null);
          }
          return;
        default:
          return;
      }
    },
    onBinary: (data) => {
      const bytes = new Uint8Array(data);
      if (playback) playback.onBytes(bytes);
      else pending.push(bytes);
    },
    onClose: () => {
      if (!closed) setStatus("disconnected");
    },
  });

  return {
    tick(now: number): void {
      if (!playback) return;
      const first = playback.frame();
      const frames = playback.tick(now);
      for (let i = 0; i < frames.length; i++) {
        deps.core.step(first + i, frames[i]!);
      }
      if (frames.length > 0 && status !== "playing") setStatus("playing");
    },
    frame: () => playback?.frame() ?? 0,
    status: () => status,
    players: () => [...players],
    close: () => {
      closed = true;
      client.close();
      deps.video?.stop();
      // The viewer owns the core on the watch route (like the play controller
      // does on play routes), so stop MAME/Emscripten with it.
      deps.core.destroy();
    },
  };
}
