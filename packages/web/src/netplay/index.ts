/**
 * Netplay public surface (T23): the RTC peer/mesh, the relay client, the
 * composed session, the browser adapters and ICE configuration.
 */
export { createPeer, UNRELIABLE_CHANNEL } from "./peer";
export type { PeerSignalling, RtcPeer, RtcPeerOptions } from "./peer";
export { createMesh } from "./mesh";
export type { Mesh, MeshDeps, MeshPlayer } from "./mesh";
export { createRelayClient } from "./relay-client";
export type { RelayClient, RelayClientOptions, RelayJoin } from "./relay-client";
export { createSession } from "./session";
export type { NetplaySession, SessionOptions } from "./session";
export { applyPacket, buildInputPacket, createFrameTable } from "./inputs";
export type { BuildPacketOptions, FrameTable } from "./inputs";
export { createLockstep } from "./lockstep";
export type {
  Lockstep,
  LockstepDeps,
  LockstepStatus,
} from "./lockstep";
export { createMatch } from "./match";
export type { MatchDeps, MatchStatus, NetplayMatch } from "./match";
export {
  browserRtcFactory,
  browserWebSocketFactory,
  createRtcFactory,
  createWebSocketFactory,
} from "./browser";
export {
  defaultIceServers,
  iceServersFromEnv,
  relayConfigFromEnv,
} from "./config";
export type { NetplayEnv, RelayConfig, RelayEnv } from "./config";
export type {
  DataChannelLike,
  DataChannelOptions,
  IceCandidateLike,
  IceServer,
  NetplayConfig,
  PeerConnectionLike,
  RtcFactory,
  SessionDescriptionLike,
  WebSocketFactory,
  WebSocketLike,
} from "./types";
