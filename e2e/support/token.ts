/**
 * Room-join JWT minting for the e2e harness (T26). Mirrors the relay verifier
 * (`packages/relay/src/token.ts`): HS256 over the raw `header.payload`, `sub`
 * non-empty and `exp` in the future. Distinct `sub` per tab so the relay seats
 * them as separate players rather than reattaching one to the other.
 */
import { createHmac } from "node:crypto";

const b64url = (buffer: Buffer): string => buffer.toString("base64url");

/** Mint an HS256 JWT accepted by a relay started with `secret`. */
export function mintToken(secret: string, sub: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = b64url(Buffer.from(JSON.stringify({ sub, name: sub, exp })));
  const signature = b64url(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}
