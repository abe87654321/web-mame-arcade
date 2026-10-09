import { describe, expect, it, vi } from "vitest";
import type { IceCandidateLike } from "./types";
import { FakeDataChannel, FakePeerConnection } from "./test-fakes";
import { UNRELIABLE_CHANNEL, createPeer, type PeerSignalling } from "./peer";

function collectSignals(): {
  signals: PeerSignalling[];
  onSignalling: (signal: PeerSignalling) => void;
} {
  const signals: PeerSignalling[] = [];
  return { signals, onSignalling: (signal) => signals.push(signal) };
}

describe("createPeer", () => {
  it("has the unreliable unordered data-channel options", () => {
    expect(UNRELIABLE_CHANNEL).toEqual({ ordered: false, maxRetransmits: 0 });
  });

  it("initiator opens an unordered unreliable channel and sends an offer", async () => {
    const pc = new FakePeerConnection();
    const { signals, onSignalling } = collectSignals();
    const peer = createPeer({ pc, initiator: true, onSignalling });

    await peer.start();

    expect(pc.lastChannelOptions).toEqual({ ordered: false, maxRetransmits: 0 });
    expect(pc.offers).toBe(1);
    expect(signals).toEqual([{ sdp: { type: "offer", sdp: "offer-sdp" } }]);
    expect(peer.channel()).toBe(pc.dataChannels[0]);
  });

  it("answerer stays quiet until an offer arrives", async () => {
    const pc = new FakePeerConnection();
    const { signals, onSignalling } = collectSignals();
    const peer = createPeer({ pc, initiator: false, onSignalling });

    await peer.start();

    expect(pc.offers).toBe(0);
    expect(signals).toEqual([]);
  });

  it("answerer answers a remote offer", async () => {
    const pc = new FakePeerConnection();
    const { signals, onSignalling } = collectSignals();
    const peer = createPeer({ pc, initiator: false, onSignalling });

    await peer.acceptRemote({ type: "offer", sdp: "remote-offer" });

    expect(pc.remoteDescriptions).toEqual([{ type: "offer", sdp: "remote-offer" }]);
    expect(pc.answers).toBe(1);
    expect(signals).toEqual([{ sdp: { type: "answer", sdp: "answer-sdp" } }]);
  });

  it("does not answer a remote answer", async () => {
    const pc = new FakePeerConnection();
    const { signals, onSignalling } = collectSignals();
    const peer = createPeer({ pc, initiator: true, onSignalling });

    await peer.acceptRemote({ type: "answer", sdp: "remote-answer" });

    expect(pc.answers).toBe(0);
    expect(signals).toEqual([]);
  });

  it("forwards gathered ICE candidates and ignores the end-of-candidates null", () => {
    const pc = new FakePeerConnection();
    const { signals, onSignalling } = collectSignals();
    createPeer({ pc, initiator: true, onSignalling });

    pc.emitIceCandidate({ candidate: "candidate:1" });
    pc.emitIceCandidate(null);

    expect(signals).toEqual([{ candidate: { candidate: "candidate:1" } }]);
  });

  it("buffers remote candidates until the remote description is set", async () => {
    const pc = new FakePeerConnection();
    const { onSignalling } = collectSignals();
    const peer = createPeer({ pc, initiator: false, onSignalling });
    const early: IceCandidateLike = { candidate: "early" };

    await peer.acceptCandidate(early);
    expect(pc.addedCandidates).toEqual([]);

    await peer.acceptRemote({ type: "answer", sdp: "remote" });
    expect(pc.addedCandidates).toEqual([early]);

    await peer.acceptCandidate({ candidate: "late" });
    expect(pc.addedCandidates).toEqual([early, { candidate: "late" }]);
  });

  it("surfaces an inbound data channel and its messages", () => {
    const pc = new FakePeerConnection();
    const { onSignalling } = collectSignals();
    const onMessage = vi.fn();
    const peer = createPeer({ pc, initiator: false, onSignalling, onMessage });

    const channel = new FakeDataChannel("netplay");
    pc.emitDataChannel(channel);
    channel.emitMessage("frame-input");

    expect(peer.channel()).toBe(channel);
    expect(onMessage).toHaveBeenCalledWith("frame-input");
  });

  it("sends only while the channel is open", async () => {
    const pc = new FakePeerConnection();
    const { onSignalling } = collectSignals();
    const peer = createPeer({ pc, initiator: true, onSignalling });
    await peer.start();
    const channel = pc.dataChannels[0]!;
    const data = new ArrayBuffer(4);

    expect(peer.send(data)).toBe(true);
    expect(channel.sent).toEqual([data]);

    channel.close();
    expect(peer.send(data)).toBe(false);
  });

  it("closes the underlying connection", () => {
    const pc = new FakePeerConnection();
    const { onSignalling } = collectSignals();
    const peer = createPeer({ pc, initiator: true, onSignalling });

    peer.close();

    expect(pc.closes).toBe(1);
  });
});
