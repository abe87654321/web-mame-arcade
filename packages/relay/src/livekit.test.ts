import { TokenVerifier } from "livekit-server-sdk";
import { describe, expect, it } from "vitest";
import { mintLivekitToken, type LivekitConfig } from "./livekit.ts";

const config: LivekitConfig = {
  url: "wss://livekit.example.test",
  apiKey: "APIkey123",
  apiSecret: "supersecret_at_least_32_chars_long",
  ttlSec: 600,
};

function decodePayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
}

describe("mintLivekitToken", () => {
  it("signs a token LiveKit's own verifier accepts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintLivekitToken(
      config,
      { identity: "user-1", name: "Alice", room: "room-a", canPublish: true },
      now,
    );
    const verifier = new TokenVerifier(config.apiKey, config.apiSecret);
    const claims = await verifier.verify(token);
    expect(claims.sub).toBe("user-1");
    expect(claims.name).toBe("Alice");
    expect(claims.video?.room).toBe("room-a");
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.canPublish).toBe(true);
    expect(claims.video?.canSubscribe).toBe(true);
  });

  it("grants the host publish and a viewer subscribe-only", () => {
    const host = decodePayload(
      mintLivekitToken(
        config,
        { identity: "host", room: "r", canPublish: true },
        1_000,
      ),
    );
    const viewer = decodePayload(
      mintLivekitToken(
        config,
        { identity: "viewer", room: "r", canPublish: false },
        1_000,
      ),
    );
    expect(host.video).toMatchObject({ canPublish: true, canSubscribe: true });
    expect(viewer.video).toMatchObject({ canPublish: false, canSubscribe: true });
  });

  it("is deterministic given `now`, honours ttl and encodes the identity", () => {
    const grant = { identity: "user-1", room: "r", canPublish: true };
    const a = mintLivekitToken(config, grant, 5_000);
    const b = mintLivekitToken(config, grant, 5_000);
    expect(a).toBe(b);
    const claims = decodePayload(a);
    expect(claims.iss).toBe(config.apiKey);
    expect(claims.nbf).toBe(5_000);
    expect(claims.iat).toBe(5_000);
    expect(claims.exp).toBe(5_600);
    expect(claims.sub).toBe("user-1");
    expect(claims.name).toBeUndefined();
  });

  it("rejects a tampered signature via the verifier", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintLivekitToken(
      config,
      { identity: "user-1", room: "r", canPublish: true },
      now,
    );
    const [header, payload] = token.split(".");
    const forged = `${header}.${payload}.AAAA`;
    const verifier = new TokenVerifier(config.apiKey, config.apiSecret);
    await expect(verifier.verify(forged)).rejects.toBeDefined();
  });
});
