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
export { createPlayback } from "./playback";
export type { Playback, PlaybackDeps } from "./playback";
export { createReplay, frameInputsAt } from "./replay";
export type {
  Replay,
  ReplayDeps,
  ReplayProgress,
  ReplayStatus,
} from "./replay";
export { createVideoPublisher, createVideoSubscriber } from "./video";
export type {
  VideoPublisher,
  VideoPublisherDeps,
  VideoSubscriber,
  VideoSubscriberDeps,
} from "./video";
export {
  browserLiveKitFactory,
  liveKitFactoryFromEnv,
  mockLiveKitFactory,
} from "./livekit";
export type { LiveKitFactory, VideoRoom } from "./livekit";
export { createMetrics } from "./metrics";
export type {
  Metrics,
  MetricsDeps,
  MetricsSnapshot,
  PacketSource,
  PacketView,
  PeerMetrics,
} from "./metrics";
export { createViewer } from "./viewer";
export type {
  Viewer,
  ViewerDeps,
  ViewerPlayer,
  ViewerStatus,
} from "./viewer";
export { createLockstep } from "./lockstep";
export type {
  Lockstep,
  LockstepDeps,
  LockstepStatus,
} from "./lockstep";
export { createMatch } from "./match";
export type {
  LobbyPlayer,
  LobbyState,
  MatchDeps,
  MatchGame,
  MatchStatus,
  NetplayMatch,
} from "./match";
export { createScoreboard, isSampleDue } from "./scoreboard";
export type { ScoreRow, Scoreboard } from "./scoreboard";
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
