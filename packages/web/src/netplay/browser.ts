/**
 * Browser adapters for the injected netplay surface (T23). The factory
 * functions take the global constructor as an argument so they are testable;
 * the `browser*` helpers bind the real globals for the app.
 */
import type {
  IceServer,
  PeerConnectionLike,
  RtcFactory,
  WebSocketFactory,
  WebSocketLike,
} from "./types";

type PeerConnectionCtor = new (config: {
  iceServers: IceServer[];
}) => PeerConnectionLike;
type WebSocketCtor = new (url: string) => WebSocketLike;

export function createRtcFactory(PeerConnection: PeerConnectionCtor): RtcFactory {
  return {
    createPeerConnection: (config) => new PeerConnection(config),
  };
}

export function createWebSocketFactory(
  WebSocketImpl: WebSocketCtor,
): WebSocketFactory {
  return {
    create: (url) => new WebSocketImpl(url),
  };
}

export function browserRtcFactory(): RtcFactory {
  return createRtcFactory(
    globalThis.RTCPeerConnection as unknown as PeerConnectionCtor,
  );
}

export function browserWebSocketFactory(): WebSocketFactory {
  return createWebSocketFactory(globalThis.WebSocket as unknown as WebSocketCtor);
}
