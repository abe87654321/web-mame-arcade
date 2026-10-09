import { describe, expect, it } from "vitest";
import {
  browserRtcFactory,
  browserWebSocketFactory,
  createMesh,
  createPeer,
  createRelayClient,
  createSession,
  defaultIceServers,
  iceServersFromEnv,
} from "./index";

describe("netplay index", () => {
  it("re-exports the netplay factories", () => {
    for (const factory of [
      createPeer,
      createMesh,
      createRelayClient,
      createSession,
      browserRtcFactory,
      browserWebSocketFactory,
      defaultIceServers,
      iceServersFromEnv,
    ]) {
      expect(typeof factory).toBe("function");
    }
  });
});
