/**
 * Test doubles for the injected WebRTC surface (T23). Not production code:
 * only `*.test.ts` files import this module.
 */
import type {
  DataChannelLike,
  DataChannelOptions,
  IceCandidateLike,
  PeerConnectionLike,
  RtcFactory,
  SessionDescriptionLike,
  WebSocketFactory,
  WebSocketLike,
} from "./types";

export class FakeDataChannel implements DataChannelLike {
  readonly label: string;
  readyState = "open";
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: ArrayBuffer[] = [];
  closed = false;

  constructor(label: string) {
    this.label = label;
  }

  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = "closed";
  }

  /** Test helper: simulate the remote opening this channel. */
  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  /** Test helper: simulate an inbound message. */
  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}

export class FakePeerConnection implements PeerConnectionLike {
  connectionState = "new";
  localDescription: SessionDescriptionLike | null = null;
  onicecandidate:
    | ((event: { candidate: IceCandidateLike | null }) => void)
    | null = null;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null = null;
  readonly dataChannels: FakeDataChannel[] = [];
  lastChannelOptions: DataChannelOptions | undefined;
  readonly remoteDescriptions: SessionDescriptionLike[] = [];
  readonly addedCandidates: IceCandidateLike[] = [];
  closes = 0;
  offers = 0;
  answers = 0;

  createDataChannel(label: string, options?: DataChannelOptions): DataChannelLike {
    const channel = new FakeDataChannel(label);
    this.lastChannelOptions = options;
    this.dataChannels.push(channel);
    return channel;
  }

  async createOffer(): Promise<SessionDescriptionLike> {
    this.offers += 1;
    return { type: "offer", sdp: "offer-sdp" };
  }

  async createAnswer(): Promise<SessionDescriptionLike> {
    this.answers += 1;
    return { type: "answer", sdp: "answer-sdp" };
  }

  async setLocalDescription(description: SessionDescriptionLike): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: SessionDescriptionLike): Promise<void> {
    this.remoteDescriptions.push(description);
  }

  async addIceCandidate(candidate: IceCandidateLike): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  close(): void {
    this.closes += 1;
    this.connectionState = "closed";
  }

  /** Test helper: simulate a locally gathered ICE candidate. */
  emitIceCandidate(candidate: IceCandidateLike | null): void {
    this.onicecandidate?.({ candidate });
  }

  /** Test helper: simulate the remote side opening a data channel. */
  emitDataChannel(channel: DataChannelLike): void {
    this.ondatachannel?.({ channel });
  }
}

/** An `RtcFactory` that hands out pre-built fake connections in order. */
export function fakeRtcFactory(
  connections: FakePeerConnection[],
): RtcFactory {
  let index = 0;
  return {
    createPeerConnection(): PeerConnectionLike {
      const connection = connections[index];
      index += 1;
      if (!connection) throw new Error("fakeRtcFactory: out of connections");
      return connection;
    },
  };
}

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSED = 3;

export class FakeWebSocket implements WebSocketLike {
  readyState = CONNECTING;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: (string | ArrayBuffer)[] = [];
  closes = 0;

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== OPEN) throw new Error("send on a closed socket");
    this.sent.push(data);
  }

  close(): void {
    this.closes += 1;
    this.readyState = CLOSED;
    this.onclose?.();
  }

  /** Test helper: simulate the connection opening. */
  open(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  /** Test helper: simulate an inbound frame. */
  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}

/** A `WebSocketFactory` that always returns the same fake socket. */
export function fakeSocketFactory(socket: FakeWebSocket): WebSocketFactory {
  return { create: () => socket };
}
