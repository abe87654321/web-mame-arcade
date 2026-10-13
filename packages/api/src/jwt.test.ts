import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";
import { issueSessionToken, signHs256 } from "./jwt";

describe("password", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong password", stored)).toBe(false);
  });

  it("produces a different hash for the same password (random salt)", async () => {
    const a = await hashPassword("hunter2");
    const b = await hashPassword("hunter2");
    expect(a).not.toBe(b);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$AA$BB")).toBe(false);
  });
});

describe("jwt", () => {
  it("signs claims that the relay verifier accepts", async () => {
    const { createHs256Verifier } = await import("@wma/relay");
    const secret = "shared-test-secret";
    const exp = 1_700_000_000;
    const token = signHs256({ sub: "42", name: "alice", exp }, secret);
    const verifier = createHs256Verifier(secret, { now: () => exp - 10 });
    expect(verifier.verify(token)).toEqual({ sub: "42", name: "alice", exp });
  });

  it("is rejected by the relay verifier under a different secret", async () => {
    const { createHs256Verifier } = await import("@wma/relay");
    const token = signHs256({ sub: "42", exp: 1_700_000_000 }, "secret-a");
    const verifier = createHs256Verifier("secret-b", { now: () => 1_699_999_990 });
    expect(() => verifier.verify(token)).toThrow();
  });

  it("issues a token expiring ttl seconds after the injected clock", async () => {
    const { token, claims } = issueSessionToken({
      sub: "7",
      name: "bob",
      secret: "s",
      ttlSec: 3600,
      now: 1_000,
    });
    expect(claims).toEqual({ sub: "7", name: "bob", exp: 4_600 });
    const { createHs256Verifier } = await import("@wma/relay");
    expect(createHs256Verifier("s", { now: () => 1_500 }).verify(token).sub).toBe("7");
  });
});
