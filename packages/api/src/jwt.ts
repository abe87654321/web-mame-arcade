/**
 * Room-join JWT issuance (T34). The relay verifies these with
 * `createHs256Verifier` (packages/relay/src/token.ts); the claims match the
 * contract in docs/contracts/ws-messages.md ("Auth"): `sub` (the `users.id`),
 * optional `name`, and `exp` in unix seconds.
 */
import { createHmac } from "node:crypto";

export interface SessionClaims {
  /** User id, as a string; also the relay's `sub`. */
  sub: string;
  /** Optional display name. */
  name?: string;
  /** Expiry, unix seconds. */
  exp: number;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/** Sign an HS256 JWT with an explicit claim set (used by tests and issuance). */
export function signHs256(claims: SessionClaims, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest();
  return `${header}.${payload}.${base64url(signature)}`;
}

export interface IssueOptions {
  sub: string;
  name?: string;
  secret: string;
  /** Token lifetime in seconds. */
  ttlSec: number;
  /** Clock in unix seconds; injectable for tests. Defaults to now. */
  now?: number;
}

/** Mint a session token; `exp` = now + ttlSec. */
export function issueSessionToken(options: IssueOptions): {
  token: string;
  claims: SessionClaims;
} {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const claims: SessionClaims = { sub: options.sub, exp: now + options.ttlSec };
  if (options.name !== undefined) claims.name = options.name;
  return { token: signHs256(claims, options.secret), claims };
}
