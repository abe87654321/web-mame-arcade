import { describe, expect, it } from "vitest";
import {
  applyPacket,
  browserRtcFactory,
  browserWebSocketFactory,
  buildInputPacket,
  createFrameTable,
  createLockstep,
  createMatch,
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
      createLockstep,
      createMatch,
      createFrameTable,
      buildInputPacket,
      applyPacket,
      browserRtcFactory,
      browserWebSocketFactory,
      defaultIceServers,
      iceServersFromEnv,
    ]) {
      expect(typeof factory).toBe("function");
    }
  });
});
