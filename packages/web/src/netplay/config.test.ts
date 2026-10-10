import { describe, expect, it } from "vitest";
import {
  defaultIceServers,
  iceServersFromEnv,
  relayConfigFromEnv,
} from "./config";

describe("iceServersFromEnv", () => {
  it("returns no servers for an empty environment", () => {
    expect(iceServersFromEnv({})).toEqual([]);
  });

  it("adds a STUN server", () => {
    expect(iceServersFromEnv({ VITE_STUN_URL: "stun:stun.test:3478" })).toEqual([
      { urls: "stun:stun.test:3478" },
    ]);
  });

  it("adds a TURN server with its credentials", () => {
    expect(
      iceServersFromEnv({
        VITE_STUN_URL: "stun:stun.test:3478",
        VITE_TURN_URL: "turn:turn.test:3478",
        VITE_TURN_USERNAME: "user",
        VITE_TURN_CREDENTIAL: "secret",
      }),
    ).toEqual([
      { urls: "stun:stun.test:3478" },
      { urls: "turn:turn.test:3478", username: "user", credential: "secret" },
    ]);
  });

  it("adds TURN without credentials when none are configured", () => {
    expect(iceServersFromEnv({ VITE_TURN_URL: "turns:turn.test:5349" })).toEqual([
      { urls: "turns:turn.test:5349" },
    ]);
  });
});

describe("defaultIceServers", () => {
  it("returns a list of ICE servers", () => {
    expect(Array.isArray(defaultIceServers())).toBe(true);
  });
});

describe("relayConfigFromEnv", () => {
  it("is null until both the relay URL and token are set", () => {
    expect(relayConfigFromEnv({})).toBeNull();
    expect(relayConfigFromEnv({ VITE_RELAY_URL: "ws://relay.test/ws" })).toBeNull();
    expect(relayConfigFromEnv({ VITE_RELAY_TOKEN: "jwt" })).toBeNull();
  });

  it("returns the relay URL and token when both are present", () => {
    expect(
      relayConfigFromEnv({
        VITE_RELAY_URL: "ws://relay.test/ws",
        VITE_RELAY_TOKEN: "jwt",
      }),
    ).toEqual({ relayUrl: "ws://relay.test/ws", token: "jwt" });
  });
});
