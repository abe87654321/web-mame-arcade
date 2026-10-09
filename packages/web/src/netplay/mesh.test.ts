import { describe, expect, it, vi } from "vitest";
import { createMesh } from "./mesh";
import { FakeDataChannel, FakePeerConnection, fakeRtcFactory } from "./test-fakes";
import type { PeerSignalling } from "./peer";

interface SentSignal {
  to: number;
  signal: PeerSignalling;
}

function harness(
  mySlot: number,
  connections: FakePeerConnection[],
  onMessage?: (from: number, data: unknown) => void,
) {
  const sent: SentSignal[] = [];
  const mesh = createMesh({
    mySlot,
    factory: fakeRtcFactory(connections),
    iceServers: [],
    sendSignal: (to, signal) => sent.push({ to, signal }),
    ...(onMessage ? { onMessage } : {}),
  });
  const player = (slot: number) => ({ slot, name: `p${slot}` });
  return { mesh, sent, player };
}

describe("createMesh", () => {
  it("has the lower slot offer to each higher slot", async () => {
    const pc = new FakePeerConnection();
    const { mesh, sent, player } = harness(0, [pc]);

    await mesh.setPlayers([player(0), player(1)]);

    expect(sent).toEqual([{ to: 1, signal: { sdp: { type: "offer", sdp: "offer-sdp" } } }]);
    expect(pc.lastChannelOptions).toEqual({ ordered: false, maxRetransmits: 0 });
    expect(mesh.peers()).toEqual([1]);
  });

  it("has the higher slot wait for an offer", async () => {
    const pc = new FakePeerConnection();
    const { mesh, sent, player } = harness(1, [pc]);

    await mesh.setPlayers([player(0), player(1)]);

    expect(pc.offers).toBe(0);
    expect(sent).toEqual([]);
    expect(mesh.peers()).toEqual([0]);
  });

  it("answers an offer from a lower slot", async () => {
    const pc = new FakePeerConnection();
    const { mesh, sent, player } = harness(1, [pc]);
    await mesh.setPlayers([player(0), player(1)]);

    await mesh.handleSignal(0, { sdp: { type: "offer", sdp: "remote" } });

    expect(sent).toEqual([{ to: 0, signal: { sdp: { type: "answer", sdp: "answer-sdp" } } }]);
  });

  it("routes a signal to the peer for its sender slot", async () => {
    const pc0 = new FakePeerConnection();
    const pc1 = new FakePeerConnection();
    const { mesh, player } = harness(2, [pc0, pc1]);
    await mesh.setPlayers([player(0), player(1), player(2)]);

    await mesh.handleSignal(0, { sdp: { type: "offer", sdp: "from-0" } });

    expect(pc0.remoteDescriptions).toEqual([{ type: "offer", sdp: "from-0" }]);
    expect(pc1.remoteDescriptions).toEqual([]);
  });

  it("ignores a signal from an unknown slot", async () => {
    const pc = new FakePeerConnection();
    const { mesh, player } = harness(0, [pc]);
    await mesh.setPlayers([player(0), player(1)]);

    await mesh.handleSignal(3, { sdp: { type: "offer" } });

    expect(pc.remoteDescriptions).toEqual([]);
  });

  it("closes the peer when a slot leaves", async () => {
    const pc = new FakePeerConnection();
    const { mesh, player } = harness(0, [pc]);
    await mesh.setPlayers([player(0), player(1)]);

    await mesh.setPlayers([player(0)]);

    expect(pc.closes).toBe(1);
    expect(mesh.peers()).toEqual([]);
  });

  it("sends and broadcasts on open channels only", async () => {
    const pc1 = new FakePeerConnection();
    const pc2 = new FakePeerConnection();
    const { mesh, player } = harness(0, [pc1, pc2]);
    await mesh.setPlayers([player(0), player(1), player(2)]);
    const data = new ArrayBuffer(2);

    expect(mesh.sendTo(1, data)).toBe(true);
    expect(pc1.dataChannels[0]!.sent).toEqual([data]);

    pc2.dataChannels[0]!.close();
    mesh.broadcast(data);
    expect(pc1.dataChannels[0]!.sent).toEqual([data, data]);
    expect(pc2.dataChannels[0]!.sent).toEqual([]);
  });

  it("reports inbound channel messages with their sender slot", async () => {
    const pc = new FakePeerConnection();
    const onMessage = vi.fn();
    const { mesh, player } = harness(1, [pc], onMessage);
    await mesh.setPlayers([player(0), player(1)]);

    const channel = new FakeDataChannel("netplay");
    pc.emitDataChannel(channel);
    channel.emitMessage("input");

    expect(onMessage).toHaveBeenCalledWith(0, "input");
  });

  it("closes every peer on close", async () => {
    const pc1 = new FakePeerConnection();
    const pc2 = new FakePeerConnection();
    const { mesh, player } = harness(0, [pc1, pc2]);
    await mesh.setPlayers([player(0), player(1), player(2)]);

    mesh.close();

    expect(pc1.closes).toBe(1);
    expect(pc2.closes).toBe(1);
  });
});
