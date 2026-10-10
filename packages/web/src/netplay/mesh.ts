/**
 * Full N-peer WebRTC mesh for netplay (T23). Given `room.state`, it keeps one
 * {@link RtcPeer} per other player slot. Deterministic negotiation: the lower
 * slot of each pair initiates (creates the data channel and offers), the higher
 * slot answers. SDP/ICE is exchanged through the relay as `rtc.signal`, routed
 * by the relay-stamped sender slot.
 */
import { createPeer, type PeerSignalling, type RtcPeer } from "./peer";
import type { DataChannelLike, IceServer, RtcFactory } from "./types";

export interface MeshPlayer {
  slot: number;
  name: string;
}

export interface MeshDeps {
  /** This client's player slot (0-3). */
  mySlot: number;
  factory: RtcFactory;
  iceServers: IceServer[];
  /** Send `rtc.signal` to the relay for the given target slot. */
  sendSignal: (to: number, signal: PeerSignalling) => void;
  /** Inbound data-channel message, tagged with the sending peer's slot. */
  onMessage?: (from: number, data: unknown) => void;
  /** A peer's data channel opened; the mesh can now reach that slot. */
  onChannelOpen?: (slot: number) => void;
}

export interface Mesh {
  /** Reconcile peers with a new `room.state` player list. */
  setPlayers(players: readonly MeshPlayer[]): Promise<void>;
  /** Apply a relayed signal from the peer in `from`. */
  handleSignal(from: number, signal: PeerSignalling): Promise<void>;
  sendTo(slot: number, data: ArrayBuffer): boolean;
  broadcast(data: ArrayBuffer): void;
  channelTo(slot: number): DataChannelLike | null;
  /** Connected peer slots, ascending. */
  peers(): number[];
  close(): void;
}

export function createMesh(deps: MeshDeps): Mesh {
  const { mySlot, factory, iceServers, sendSignal, onMessage, onChannelOpen } = deps;
  const peers = new Map<number, RtcPeer>();

  function addPeer(slot: number): Promise<void> {
    const initiator = mySlot < slot;
    const pc = factory.createPeerConnection({ iceServers });
    const peer = createPeer({
      pc,
      initiator,
      onSignalling: (signal) => sendSignal(slot, signal),
      ...(onMessage
        ? { onMessage: (data: unknown) => onMessage(slot, data) }
        : {}),
      ...(onChannelOpen ? { onOpen: () => onChannelOpen(slot) } : {}),
    });
    peers.set(slot, peer);
    return initiator ? peer.start() : Promise.resolve();
  }

  return {
    async setPlayers(players: readonly MeshPlayer[]): Promise<void> {
      const present = new Set<number>();
      const pending: Promise<void>[] = [];
      for (const player of players) {
        if (player.slot === mySlot) continue;
        present.add(player.slot);
        if (!peers.has(player.slot)) pending.push(addPeer(player.slot));
      }
      for (const [slot, peer] of peers) {
        if (!present.has(slot)) {
          peer.close();
          peers.delete(slot);
        }
      }
      await Promise.all(pending);
    },

    async handleSignal(from: number, signal: PeerSignalling): Promise<void> {
      const peer = peers.get(from);
      if (!peer) return;
      if (signal.sdp) await peer.acceptRemote(signal.sdp);
      if (signal.candidate) await peer.acceptCandidate(signal.candidate);
    },

    sendTo(slot: number, data: ArrayBuffer): boolean {
      const peer = peers.get(slot);
      return peer ? peer.send(data) : false;
    },

    broadcast(data: ArrayBuffer): void {
      for (const peer of peers.values()) peer.send(data);
    },

    channelTo(slot: number): DataChannelLike | null {
      const peer = peers.get(slot);
      return peer ? peer.channel() : null;
    },

    peers(): number[] {
      return [...peers.keys()].sort((a, b) => a - b);
    },

    close(): void {
      for (const peer of peers.values()) peer.close();
      peers.clear();
    },
  };
}
