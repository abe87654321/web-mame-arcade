import { describe, expect, it } from "vitest";
import { iceServersFromEnv } from "./config";

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
