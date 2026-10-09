import { describe, expect, it } from "vitest";
import {
  browserRtcFactory,
  browserWebSocketFactory,
  createRtcFactory,
  createWebSocketFactory,
} from "./browser";
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

describe("browserRtcFactory", () => {
  it("binds the global RTCPeerConnection", () => {
    const original = (globalThis as { RTCPeerConnection?: unknown })
      .RTCPeerConnection;
    const seen: unknown[] = [];
    class Stub {
      constructor(config: unknown) {
        seen.push(config);
      }
    }
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = Stub;
    try {
      browserRtcFactory().createPeerConnection({ iceServers: [{ urls: "stun:x" }] });
    } finally {
      (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = original;
    }
    expect(seen).toEqual([{ iceServers: [{ urls: "stun:x" }] }]);
  });
});

describe("browserWebSocketFactory", () => {
  it("binds the global WebSocket", () => {
    const original = (globalThis as { WebSocket?: unknown }).WebSocket;
    const seen: string[] = [];
    class Stub {
      constructor(url: string) {
        seen.push(url);
      }
    }
    (globalThis as { WebSocket?: unknown }).WebSocket = Stub;
    try {
      browserWebSocketFactory().create("ws://relay.test/ws");
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = original;
    }
    expect(seen).toEqual(["ws://relay.test/ws"]);
  });
});
