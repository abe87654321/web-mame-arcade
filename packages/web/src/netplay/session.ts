/**
 * Netplay session (T23): wires the relay WebSocket client to the RTC mesh. A
 * `room.state` with a non-null `self` creates (or refreshes) the mesh; relayed
 * `rtc.signal` messages are routed to the peer for the stamped sender slot.
 */
import type { RtcSignal, ServerMessage } from "@wma/protocol";
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
  /** A handler/message-processing error; never thrown out of the socket callback. */
  onError?: (error: unknown) => void;
}

export interface NetplaySession {
  /** Apply a message from the relay. Exposed so tests drive it directly. */
  handleMessage(message: ServerMessage): Promise<void>;
  sendTo(slot: number, data: ArrayBuffer): boolean;
  broadcast(data: ArrayBuffer): void;
  peers(): number[];
  close(): void;
}

export function createSession(options: SessionOptions): NetplaySession {
  const { config, factory, onMessage, onError } = options;
  let mesh: Mesh | null = null;
  /** False until the first `room.state` has populated the mesh's peers. */
  let meshReady = false;
  /** Signals that arrived before the mesh could route them (docs/03 race). */
  const pendingSignals: { from: number; signal: PeerSignalling }[] = [];

  const client = createRelayClient({
    url: config.relayUrl,
    join: { room: config.room, role: config.role, token: config.token },
    socketFactory: options.socketFactory,
    onMessage: (message) => {
      handleMessage(message).catch((error) => onError?.(error));
    },
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
        ...(onMessage ? { onMessage } : {}),
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
        if (message.self === null) return;
        const active = ensureMesh(message.self);
        await active.setPlayers(message.players);
        meshReady = true;
        await flushPendingSignals();
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
    sendTo: (slot, data) => (mesh ? mesh.sendTo(slot, data) : false),
    broadcast: (data) => {
      mesh?.broadcast(data);
    },
    peers: () => (mesh ? mesh.peers() : []),
    close: () => {
      mesh?.close();
      mesh = null;
      client.close();
    },
  };
}
