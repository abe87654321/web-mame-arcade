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
  const { config, factory, onMessage } = options;
  let mesh: Mesh | null = null;

  const client = createRelayClient({
    url: config.relayUrl,
    join: { room: config.room, role: config.role, token: config.token },
    socketFactory: options.socketFactory,
    onMessage: (message) => {
      void handleMessage(message);
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

  async function handleMessage(message: ServerMessage): Promise<void> {
    switch (message.t) {
      case "room.state": {
        if (message.self === null) return;
        await ensureMesh(message.self).setPlayers(message.players);
        return;
      }
      case "rtc.signal": {
        if (!mesh || message.from === undefined) return;
        const signal: PeerSignalling = {};
        if (message.sdp) signal.sdp = message.sdp;
        if (message.candidate) signal.candidate = message.candidate;
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
