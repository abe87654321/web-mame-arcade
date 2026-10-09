/**
 * Room join token verification. Contract: docs/contracts/ws-messages.md
 * ("Auth"). Tokens are HS256 JWTs issued by the API (T34); the relay only
 * verifies them. No external dependency: node:crypto provides the HMAC.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface TokenClaims {
  /** Non-empty user id. */
  sub: string;
  /** Optional display name. */
  name?: string;
  /** Expiry, unix seconds. */
  exp: number;
}

export interface TokenVerifier {
  /** Returns the claims, or throws {@link TokenError}. */
  verify(token: string): TokenClaims;
}

/** Verification failure; `code` maps to the relay `error` message code. */
export class TokenError extends Error {
  readonly code = "invalid_token" as const;

  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

export interface Hs256VerifierOptions {
  /** Clock in unix seconds; injectable for tests. */
  now?: () => number;
  /** Grace for slightly-expired tokens, in seconds. */
  clockToleranceSec?: number;
}

function decodeJson(segment: string): unknown {
  const text = Buffer.from(segment, "base64url").toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new TokenError("token segment is not valid JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TokenError("token segment is not an object");
  }
  return value as Record<string, unknown>;
}

function signaturesMatch(expected: Buffer, actual: string): boolean {
  let actualBytes: Buffer;
  try {
    actualBytes = Buffer.from(actual, "base64url");
  } catch {
    return false;
  }
  if (actualBytes.length !== expected.length) return false;
  return timingSafeEqual(expected, actualBytes);
}

/** Create a verifier for HS256 JWTs signed with `secret`. */
export function createHs256Verifier(
  secret: string,
  options: Hs256VerifierOptions = {},
): TokenVerifier {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const tolerance = options.clockToleranceSec ?? 0;
  const key = Buffer.from(secret, "utf8");

  return {
    verify(token: string): TokenClaims {
      const parts = token.split(".");
      if (parts.length !== 3) throw new TokenError("token must have 3 segments");
      const [encodedHeader, encodedPayload, signature] = parts as [
        string,
        string,
        string,
      ];

      const header = asRecord(decodeJson(encodedHeader));
      if (header.alg !== "HS256") {
        throw new TokenError(`unsupported algorithm ${String(header.alg)}`);
      }

      const expected = createHmac("sha256", key)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest();
      if (!signaturesMatch(expected, signature)) {
        throw new TokenError("signature mismatch");
      }

      const payload = asRecord(decodeJson(encodedPayload));
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new TokenError("missing subject");
      }
      if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
        throw new TokenError("missing expiry");
      }
      if (payload.exp + tolerance <= now()) {
        throw new TokenError("token expired");
      }
      if (payload.name !== undefined && typeof payload.name !== "string") {
        throw new TokenError("invalid name claim");
      }

      const claims: TokenClaims = {
        sub: payload.sub,
        exp: payload.exp,
      };
      if (payload.name !== undefined) claims.name = payload.name;
      return claims;
    },
  };
}
