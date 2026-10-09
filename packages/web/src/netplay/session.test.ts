import { describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@wma/protocol";
import { createSession } from "./session";
import {
  FakeDataChannel,
  FakePeerConnection,
  FakeWebSocket,
  fakeRtcFactory,
  fakeSocketFactory,
} from "./test-fakes";

function roomState(self: number | null, slots: number[]): ServerMessage {
  return {
    t: "room.state",
    room: "r",
    self,
    players: slots.map((slot) => ({ slot, name: `p${slot}` })),
    game: null,
    coreHash: null,
    romHash: null,
    dips: {},
    status: "waiting",
  };
}

function harness(
  connections: FakePeerConnection[],
  onMessage?: (from: number, data: unknown) => void,
) {
  const socket = new FakeWebSocket();
  const session = createSession({
    config: {
      relayUrl: "ws://relay.test/ws",
      token: "jwt",
      room: "r",
      role: "player",
      iceServers: [],
    },
    socketFactory: fakeSocketFactory(socket),
    factory: fakeRtcFactory(connections),
    ...(onMessage ? { onMessage } : {}),
  });
  socket.open();
  return { socket, session };
}

describe("createSession", () => {
  it("builds a mesh from room.state and offers to higher slots", async () => {
    const pc = new FakePeerConnection();
    const { socket, session } = harness([pc]);

    await session.handleMessage(roomState(0, [0, 1]));

    expect(socket.sent).toContain(
      JSON.stringify({ t: "rtc.signal", to: 1, sdp: { type: "offer", sdp: "offer-sdp" } }),
    );
    expect(session.peers()).toEqual([1]);
  });

  it("routes a relayed offer to the mesh and answers", async () => {
    const pc = new FakePeerConnection();
    const { socket, session } = harness([pc]);
    await session.handleMessage(roomState(1, [0, 1]));

    await session.handleMessage({
      t: "rtc.signal",
      from: 0,
      to: 1,
      sdp: { type: "offer", sdp: "remote" },
    });

    expect(socket.sent).toContain(
      JSON.stringify({ t: "rtc.signal", to: 0, sdp: { type: "answer", sdp: "answer-sdp" } }),
    );
  });

  it("stays out of the mesh for a slot-less viewer", async () => {
    const socket = new FakeWebSocket();
    const session = createSession({
      config: {
        relayUrl: "ws://relay.test/ws",
        token: "jwt",
        room: "r",
        role: "viewer",
        iceServers: [],
      },
      socketFactory: fakeSocketFactory(socket),
      factory: fakeRtcFactory([]),
    });
    socket.open();

    await session.handleMessage(roomState(null, [0, 1]));
    await session.handleMessage({ t: "rtc.signal", from: 0, to: 1, sdp: { type: "offer" } });

    expect(session.peers()).toEqual([]);
    expect(socket.sent).toHaveLength(1);
  });

  it("ignores a relayed signal without a sender slot", async () => {
    const pc = new FakePeerConnection();
    const { session } = harness([pc]);
    await session.handleMessage(roomState(1, [0, 1]));

    await expect(
      session.handleMessage({ t: "rtc.signal", to: 1, candidate: { candidate: "c" } }),
    ).resolves.toBeUndefined();
    expect(pc.addedCandidates).toEqual([]);
  });

  it("forwards data-channel messages with the sender slot", async () => {
    const pc = new FakePeerConnection();
    const onMessage = vi.fn();
    const { session } = harness([pc], onMessage);
    await session.handleMessage(roomState(1, [0, 1]));

    const channel = new FakeDataChannel("netplay");
    pc.emitDataChannel(channel);
    channel.emitMessage("input");

    expect(onMessage).toHaveBeenCalledWith(0, "input");
  });

  it("does not send before a room.state arrives", () => {
    const { session } = harness([]);

    expect(session.sendTo(1, new ArrayBuffer(2))).toBe(false);
    expect(() => session.broadcast(new ArrayBuffer(2))).not.toThrow();
  });

  it("sends and broadcasts through the mesh once playing", async () => {
    const pc1 = new FakePeerConnection();
    const pc2 = new FakePeerConnection();
    const { session } = harness([pc1, pc2]);
    await session.handleMessage(roomState(0, [0, 1, 2]));
    const data = new ArrayBuffer(2);

    expect(session.sendTo(1, data)).toBe(true);
    session.broadcast(data);

    expect(pc1.dataChannels[0]!.sent).toEqual([data, data]);
    expect(pc2.dataChannels[0]!.sent).toEqual([data]);
  });

  it("closes the mesh and the socket", async () => {
    const pc = new FakePeerConnection();
    const { socket, session } = harness([pc]);
    await session.handleMessage(roomState(0, [0, 1]));

    session.close();

    expect(pc.closes).toBe(1);
    expect(socket.closes).toBe(1);
  });
});
