/**
 * Injected WebRTC surface for netplay (T23). Node has no `RTCPeerConnection`,
 * and the rest of the app injects every browser global (see `AppEnv`), so the
 * peer/mesh layer depends on these structural interfaces; the browser adapter
 * (`browser.ts`) wraps the real constructors and tests supply fakes.
 *
 * Data channels are unreliable and unordered (docs/03): options are
 * `{ ordered: false, maxRetransmits: 0 }`.
 */

/** The data-channel members netplay uses. */
export interface DataChannelLike {
  readonly label: string;
  readonly readyState: string;
  binaryType: string;
  send(data: ArrayBuffer): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface SessionDescriptionLike {
  type: string;
  sdp?: string;
}

export interface IceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface DataChannelOptions {
  ordered?: boolean;
  maxRetransmits?: number;
}

/** The peer-connection members netplay uses. */
export interface PeerConnectionLike {
  readonly connectionState: string;
  localDescription: SessionDescriptionLike | null;
  createDataChannel(
    label: string,
    options?: DataChannelOptions,
  ): DataChannelLike;
  createOffer(): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(description: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: IceCandidateLike): Promise<void>;
  close(): void;
  onicecandidate:
    | ((event: { candidate: IceCandidateLike | null }) => void)
    | null;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null;
}

/** Factory for peer connections, injecting the configured ICE servers. */
export interface RtcFactory {
  createPeerConnection(config: { iceServers: IceServer[] }): PeerConnectionLike;
}

/** The WebSocket members the relay client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  /** Set to `"arraybuffer"` so inbound input packets are not Blobs. */
  binaryType: string;
  send(data: string | ArrayBuffer): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Creates the relay WebSocket; injected so tests need no network. */
export interface WebSocketFactory {
  create(url: string): WebSocketLike;
}

/** Netplay wiring: where the relay lives and how to reach TURN/STUN. */
export interface NetplayConfig {
  /** Relay WebSocket URL, e.g. `ws://localhost:8787/ws`. */
  relayUrl: string;
  /** HS256 room-join JWT (issued by the API, T34). */
  token: string;
  room: string;
  role: "player" | "viewer";
  iceServers: IceServer[];
}
