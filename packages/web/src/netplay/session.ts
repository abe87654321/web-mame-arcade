/**
 * Netplay session (T23): wires the relay WebSocket client to the RTC mesh. A
 * `room.state` with a non-null `self` creates (or refreshes) the mesh; relayed
 * `rtc.signal` messages are routed to the peer for the stamped sender slot.
 */
import type {
  ClientMessage,
  GameStart,
  PlayerReady,
  RoomState,
  RtcSignal,
  ServerMessage,
} from "@wma/protocol";
import { createMesh, type Mesh } from "./mesh";
import type { PeerSignalling } from "./peer";
import { createRelayClient } from "./relay-client";
import type { NetplayConfig, RtcFactory, WebSocketFactory } from "./types";

export interface SessionOptions {
  config: NetplayConfig;
  socketFactory: WebSocketFactory;
  factory: RtcFactory;
  /** Inbound data-channel message, tagged with the sender slot. */
  onMessage?: (from: number, data: unknown) => void;
  /** Inbound binary input packet from a peer (data channel) or the relay. */
  onInput?: (bytes: Uint8Array) => void;
  /** The latest personal `room.state` (self slot, players, status). */
  onRoomState?: (message: RoomState) => void;
  /** The host's `game.start`, fanned out by the relay. */
  onGameStart?: (message: GameStart) => void;
  /** A player toggled its ready flag (relay-stamped slot + flag). */
  onPlayerReady?: (message: PlayerReady) => void;
  /** A peer's data channel opened or closed (lobby connected/ready badges). */
  onPeersChanged?: () => void;
  /** A peer's data channel opened (may let a match start). */
  onChannelOpen?: (slot: number) => void;
  /** The relay socket closed (self-disconnect). */
  onClose?: () => void;
  /** A handler/message-processing error; never thrown out of the socket callback. */
  onError?: (error: unknown) => void;
}

export interface NetplaySession {
  /** Apply a message from the relay. Exposed so tests drive it directly. */
  handleMessage(message: ServerMessage): Promise<void>;
  /** Send a client JSON message to the relay (e.g. game.start). */
  send(message: ClientMessage): boolean;
  sendTo(slot: number, data: ArrayBuffer): boolean;
  broadcast(data: ArrayBuffer): void;
  /** Send a binary input packet to the relay. */
  sendBinary(data: ArrayBuffer): boolean;
  /** Connected peer slots, ascending. */
  peers(): number[];
  /** True when the data channel to `slot` is open (that peer is connected). */
  peerOpen(slot: number): boolean;
  /** Our own player slot, or null before `room.state`/for a viewer. */
  self(): number | null;
  /** Player slots in the room, ascending, from the latest `room.state`. */
  players(): number[];
  /**
   * True when every current peer's data channel is open. A lone player has no
   * peers, so this is vacuously true and they may start a solo netplay game.
   */
  ready(): boolean;
  close(): void;
}

/** Normalise a data-channel payload (ArrayBuffer or view) to bytes. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export function createSession(options: SessionOptions): NetplaySession {
  const { config, factory, onMessage, onInput, onError } = options;
  let mesh: Mesh | null = null;
  /** False until the first `room.state` has populated the mesh's peers. */
  let meshReady = false;
  /** Signals that arrived before the mesh could route them (docs/03 race). */
  const pendingSignals: { from: number; signal: PeerSignalling }[] = [];
  let selfSlot: number | null = null;
  let roomPlayers: number[] = [];

  const client = createRelayClient({
    url: config.relayUrl,
    join: { room: config.room, role: config.role, token: config.token },
    socketFactory: options.socketFactory,
    onMessage: (message) => {
      handleMessage(message).catch((error) => onError?.(error));
    },
    onBinary: (data) => onInput?.(new Uint8Array(data)),
    ...(options.onClose ? { onClose: options.onClose } : {}),
  });

  function ensureMesh(mySlot: number): Mesh {
    if (!mesh) {
      mesh = createMesh({
        mySlot,
        factory,
        iceServers: config.iceServers,
        sendSignal: (to, signal) => {
          const message: RtcSignal = { t: "rtc.signal", to };
          if (signal.sdp) message.sdp = signal.sdp as NonNullable<RtcSignal["sdp"]>;
          if (signal.candidate) message.candidate = signal.candidate;
          client.send(message);
        },
        onMessage: (from: number, data: unknown) => {
          onMessage?.(from, data);
          const bytes = toBytes(data);
          if (bytes) onInput?.(bytes);
        },
        ...(options.onChannelOpen || options.onPeersChanged
          ? {
              onChannelOpen: (slot: number) => {
                options.onChannelOpen?.(slot);
                options.onPeersChanged?.();
              },
            }
          : {}),
        ...(options.onPeersChanged
          ? { onChannelClose: () => options.onPeersChanged?.() }
          : {}),
      });
    }
    return mesh;
  }

  async function flushPendingSignals(): Promise<void> {
    if (!mesh) return;
    for (const { from, signal } of pendingSignals.splice(0)) {
      await mesh.handleSignal(from, signal);
    }
  }

  async function handleMessage(message: ServerMessage): Promise<void> {
    switch (message.t) {
      case "room.state": {
        selfSlot = message.self;
        roomPlayers = message.players.map((player) => player.slot).sort((a, b) => a - b);
        if (message.self === null) {
          options.onRoomState?.(message);
          return;
        }
        // Populate the mesh first, then announce, so a listener that checks
        // `ready()` sees the freshly created peer channels (T24 host start).
        const active = ensureMesh(message.self);
        await active.setPlayers(message.players);
        meshReady = true;
        await flushPendingSignals();
        options.onPeersChanged?.();
        options.onRoomState?.(message);
        return;
      }
      case "game.start": {
        options.onGameStart?.(message);
        return;
      }
      case "player.ready": {
        options.onPlayerReady?.(message);
        return;
      }
      case "rtc.signal": {
        if (message.from === undefined) return;
        const signal: PeerSignalling = {};
        if (message.sdp) signal.sdp = message.sdp;
        if (message.candidate) signal.candidate = message.candidate;
        // A signal can outrace the recipient's first `room.state`; hold it
        // until the mesh exists and knows its peers, then replay (docs/03).
        if (!mesh || !meshReady) {
          pendingSignals.push({ from: message.from, signal });
          return;
        }
        await mesh.handleSignal(message.from, signal);
        return;
      }
      default:
        return;
    }
  }

  return {
    handleMessage,
    send: (message) => client.send(message),
    sendTo: (slot, data) => (mesh ? mesh.sendTo(slot, data) : false),
    broadcast: (data) => {
      mesh?.broadcast(data);
    },
    sendBinary: (data) => client.sendBinary(data),
    peers: () => (mesh ? mesh.peers() : []),
    peerOpen: (slot) => mesh?.channelTo(slot)?.readyState === "open",
    self: () => selfSlot,
    players: () => [...roomPlayers],
    ready: () => {
      // Not joined yet: we do not know our slot or peers.
      if (selfSlot === null) return false;
      const slots = mesh ? mesh.peers() : [];
      return slots.every((slot) => mesh?.channelTo(slot)?.readyState === "open");
    },
    close: () => {
      mesh?.close();
      mesh = null;
      meshReady = false;
      selfSlot = null;
      roomPlayers = [];
      client.close();
    },
  };
}
