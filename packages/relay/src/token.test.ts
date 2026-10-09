import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenError, createHs256Verifier, type Hs256VerifierOptions } from "./token";

const SECRET = "test-secret";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(
  payload: unknown,
  { secret = SECRET, alg = "HS256" }: { secret?: string; alg?: string } = {},
): string {
  const header = b64url(JSON.stringify({ alg, typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${sig}`;
}

const NOW = 1_700_000_000;

function verifier(options: Hs256VerifierOptions = {}) {
  return createHs256Verifier(SECRET, { now: () => NOW, ...options });
}

describe("createHs256Verifier", () => {
  it("returns the claims of a valid token", () => {
    const token = sign({ sub: "user-1", name: "alice", exp: NOW + 60 });
    expect(verifier().verify(token)).toEqual({
      sub: "user-1",
      name: "alice",
      exp: NOW + 60,
    });
  });

  it("allows a token without the optional name", () => {
    const token = sign({ sub: "user-1", exp: NOW + 60 });
    expect(verifier().verify(token)).toEqual({ sub: "user-1", exp: NOW + 60 });
  });

  it("rejects a token signed with a different secret", () => {
    const token = sign({ sub: "user-1", exp: NOW + 60 }, { secret: "other" });
    expect(() => verifier().verify(token)).toThrow(TokenError);
  });

  it("rejects a non-HS256 algorithm", () => {
    const token = sign({ sub: "user-1", exp: NOW + 60 }, { alg: "none" });
    expect(() => verifier().verify(token)).toThrow(TokenError);
  });

  it("rejects an expired token", () => {
    const token = sign({ sub: "user-1", exp: NOW - 1 });
    expect(() => verifier().verify(token)).toThrow(TokenError);
  });

  it("tolerates expiry inside the clock skew window", () => {
    const token = sign({ sub: "user-1", exp: NOW - 5 });
    expect(verifier({ clockToleranceSec: 30 }).verify(token).sub).toBe("user-1");
  });

  it("rejects a token without a subject", () => {
    const token = sign({ exp: NOW + 60 });
    expect(() => verifier().verify(token)).toThrow(TokenError);
  });

  it("rejects malformed tokens", () => {
    for (const bad of ["", "a.b", "a.b.", "not-a-jwt", "a.b.c"]) {
      expect(() => verifier().verify(bad), bad).toThrow(TokenError);
    }
  });

  it("tags every rejection with the invalid_token code", () => {
    try {
      verifier().verify("a.b.c");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenError);
      expect((error as TokenError).code).toBe("invalid_token");
    }
  });
});
