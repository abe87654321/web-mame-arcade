/**
 * LiveKit access-token minting (T41). The relay is the only issuer: it already
 * authenticates `room.join` (HS256 JWT, token.ts), so it signs a LiveKit JWT
 * for each member and hands it over the authenticated WS (`livekit.access`).
 *
 * The token is a standard HS256 JWT with LiveKit's `video` grant. We sign it
 * with node:crypto rather than the async SDK so the relay's dispatch stays
 * synchronous and the mint is deterministic given an injected `now` (tests).
 * `livekit-server-sdk`'s TokenVerifier is used in the tests to prove the
 * hand-rolled token is one LiveKit actually accepts.
 */
import { createHmac } from "node:crypto";

export interface LivekitConfig {
  /** LiveKit WS/HTTP endpoint handed to clients (e.g. `wss://lk.example`). */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** Token lifetime in seconds; default 1 hour. */
  ttlSec?: number;
}

/** What a member is allowed to do in the LiveKit room. */
export interface AccessGrant {
  /** LiveKit identity: the member's join-token `sub` (unique per room). */
  identity: string;
  /** Optional display name. */
  name?: string;
  /** LiveKit room name (= arcade room id). */
  room: string;
  /** True for the host (publishes A/V); false for a subscribe-only viewer. */
  canPublish: boolean;
}

const DEFAULT_TTL_SEC = 3600;

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Mint a LiveKit access token for `grant`. Synchronous and pure given `now`
 * (unix seconds), so it is fully unit-testable.
 */
export function mintLivekitToken(
  config: LivekitConfig,
  grant: AccessGrant,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const ttl = config.ttlSec ?? DEFAULT_TTL_SEC;
  const header = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    iss: config.apiKey,
    sub: grant.identity,
    nbf: now,
    iat: now,
    exp: now + ttl,
    video: {
      room: grant.room,
      roomJoin: true,
      canPublish: grant.canPublish,
      canSubscribe: true,
    },
  };
  if (grant.name) payload.name = grant.name;
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(payload),
  )}`;
  const signature = createHmac("sha256", config.apiSecret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}
