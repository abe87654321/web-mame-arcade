import { describe, expect, it } from "vitest";
import { createRtcFactory, createWebSocketFactory } from "./browser";
import type { IceServer, PeerConnectionLike } from "./types";

describe("createRtcFactory", () => {
  it("constructs a peer connection with the given ICE servers", () => {
    const seen: unknown[] = [];
    class Stub {
      constructor(config: unknown) {
        seen.push(config);
      }
    }
    const factory = createRtcFactory(
      Stub as unknown as new (config: { iceServers: IceServer[] }) => PeerConnectionLike,
    );

    factory.createPeerConnection({ iceServers: [{ urls: "stun:x" }] });

    expect(seen).toEqual([{ iceServers: [{ urls: "stun:x" }] }]);
  });
});

describe("createWebSocketFactory", () => {
  it("constructs a WebSocket for the given URL", () => {
    const seen: string[] = [];
    class Stub {
      constructor(url: string) {
        seen.push(url);
      }
    }
    const factory = createWebSocketFactory(Stub as never);

    factory.create("ws://relay.test/ws");

    expect(seen).toEqual(["ws://relay.test/ws"]);
  });
});
