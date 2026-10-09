/**
 * One WebRTC peer connection for netplay (T23). Wraps an injected
 * {@link PeerConnectionLike}: the initiator opens an unreliable, unordered data
 * channel and offers; the answerer accepts the offer and answers. All SDP/ICE
 * crosses the relay as `rtc.signal` (see `mesh.ts`); trickle-ICE candidates
 * that arrive before the remote description are buffered and flushed.
 */
import type {
  DataChannelLike,
  DataChannelOptions,
  IceCandidateLike,
  PeerConnectionLike,
  SessionDescriptionLike,
} from "./types";

/** Unreliable + unordered, per docs/03-netplay-protocol.md. */
export const UNRELIABLE_CHANNEL: DataChannelOptions = {
  ordered: false,
  maxRetransmits: 0,
};

export interface PeerSignalling {
  sdp?: SessionDescriptionLike;
  candidate?: IceCandidateLike;
}

export interface RtcPeerOptions {
  pc: PeerConnectionLike;
  /** True for the lower-slot peer of a pair; it creates the data channel. */
  initiator: boolean;
  /** Data-channel label; defaults to `netplay`. */
  label?: string;
  onSignalling: (signal: PeerSignalling) => void;
  onMessage?: (data: unknown) => void;
}

export interface RtcPeer {
  readonly pc: PeerConnectionLike;
  /** The data channel, once created (initiator) or received (answerer). */
  channel(): DataChannelLike | null;
  /** Initiate negotiation. No-op for the answerer, which waits for an offer. */
  start(): Promise<void>;
  /** Apply a remote offer or answer. */
  acceptRemote(description: SessionDescriptionLike): Promise<void>;
  /** Apply a remote ICE candidate (buffered until the remote description is set). */
  acceptCandidate(candidate: IceCandidateLike): Promise<void>;
  /** Send on the data channel; false when it is not open yet. */
  send(data: ArrayBuffer): boolean;
  close(): void;
}

export function createPeer(options: RtcPeerOptions): RtcPeer {
  const { pc, initiator, onSignalling, onMessage } = options;
  const label = options.label ?? "netplay";
  let channel: DataChannelLike | null = null;
  let remoteSet = false;
  const pendingCandidates: IceCandidateLike[] = [];

  function attach(active: DataChannelLike): void {
    channel = active;
    active.binaryType = "arraybuffer";
    active.onmessage = (event) => onMessage?.(event.data);
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) onSignalling({ candidate: event.candidate });
  };
  pc.ondatachannel = (event) => attach(event.channel);

  async function flushPending(): Promise<void> {
    for (const candidate of pendingCandidates.splice(0)) {
      await pc.addIceCandidate(candidate);
    }
  }

  return {
    pc,
    channel: () => channel,

    async start(): Promise<void> {
      if (!initiator) return;
      attach(pc.createDataChannel(label, UNRELIABLE_CHANNEL));
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.localDescription) onSignalling({ sdp: pc.localDescription });
    },

    async acceptRemote(description: SessionDescriptionLike): Promise<void> {
      await pc.setRemoteDescription(description);
      remoteSet = true;
      await flushPending();
      if (description.type !== "offer") return;
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.localDescription) onSignalling({ sdp: pc.localDescription });
    },

    async acceptCandidate(candidate: IceCandidateLike): Promise<void> {
      if (!remoteSet) {
        pendingCandidates.push(candidate);
        return;
      }
      await pc.addIceCandidate(candidate);
    },

    send(data: ArrayBuffer): boolean {
      if (!channel || channel.readyState !== "open") return false;
      channel.send(data);
      return true;
    },

    close(): void {
      pc.close();
    },
  };
}
