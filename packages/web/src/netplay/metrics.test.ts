import { describe, expect, it } from "vitest";
import { createMetrics } from "./metrics";

/** A decoded input packet's diagnostic fields. */
function packet(ackFrame: number, firstFrame: number) {
  return { ackFrame, firstFrame };
}

describe("createMetrics", () => {
  it("derives per-peer RTT from the ack of a locally scheduled frame", () => {
    const metrics = createMetrics({ mySlot: 0, players: [0, 1], now: () => 0 });

    metrics.noteLocalFrame(10, 1000);
    metrics.onPeerPacket(1, packet(10, 4), "p2p", 1050);

    expect(metrics.snapshot(12).peers).toEqual([
      expect.objectContaining({ slot: 1, rttMs: 50 }),
    ]);
  });

  it("ignores a peer packet for our own slot", () => {
    const metrics = createMetrics({ mySlot: 0, players: [0, 1], now: () => 0 });

    metrics.noteLocalFrame(3, 0);
    metrics.onPeerPacket(0, packet(3, 0), "p2p", 100);

    const peer = metrics.snapshot(0).peers.find((p) => p.slot === 0);
    expect(peer).toBeUndefined();
  });

  it("leaves RTT null until an ack reaches a frame we timed", () => {
    const metrics = createMetrics({ mySlot: 0, players: [0, 1], now: () => 0 });

    metrics.onPeerPacket(1, packet(9, 0), "p2p", 100);

    expect(metrics.snapshot(0).peers[0]).toMatchObject({ slot: 1, rttMs: null });
  });

  it("counts lost packets from gaps in the firstFrame series", () => {
    const metrics = createMetrics({ mySlot: 0, players: [0, 1], now: () => 0 });

    metrics.onPeerPacket(1, packet(0, 0), "p2p", 0);
    metrics.onPeerPacket(1, packet(0, 1), "p2p", 16);
    // Frames 2..4 never arrived as new packets: three gaps.
    metrics.onPeerPacket(1, packet(0, 5), "p2p", 100);

    expect(metrics.snapshot(0).peers[0]).toMatchObject({
      lost: 3,
      received: 3,
    });
  });

  it("does not count a reordered older packet as loss", () => {
    const metrics = createMetrics({ mySlot: 0, players: [0, 1], now: () => 0 });

    metrics.onPeerPacket(1, packet(0, 10), "p2p", 0);
    metrics.onPeerPacket(1, packet(0, 3), "p2p", 20);

    expect(metrics.snapshot(0).peers[0]?.lost).toBe(0);
  });

  it("tracks jitter from inter-arrival deviation", () => {
    const metrics = createMetrics({ mySlot: 0, players: [0, 1], now: () => 0 });

    metrics.onPeerPacket(1, packet(0, 0), "p2p", 0);
    metrics.onPeerPacket(1, packet(0, 1), "p2p", 16);
    metrics.onPeerPacket(1, packet(0, 2), "p2p", 80); // a 48 ms spike

    expect(metrics.snapshot(0).peers[0]?.jitterMs).toBeGreaterThan(0);
  });

  it("tallies packets by transport source", () => {
    const metrics = createMetrics({ mySlot: 0, players: [0, 1], now: () => 0 });

    metrics.onPeerPacket(1, packet(0, 0), "p2p", 0);
    metrics.onPeerPacket(1, packet(0, 1), "relay", 16);
    metrics.onPeerPacket(1, packet(0, 2), "relay", 32);

    expect(metrics.snapshot(0).peers[0]).toMatchObject({
      p2p: 1,
      relay: 2,
      received: 3,
    });
  });

  it("reports every player except our own and resets", () => {
    const metrics = createMetrics({
      mySlot: 0,
      players: [0, 1, 2],
      now: () => 0,
    });
    metrics.onPeerPacket(1, packet(0, 0), "p2p", 0);

    expect(metrics.snapshot(5).peers.map((p) => p.slot)).toEqual([1, 2]);
    expect(metrics.snapshot(5).frame).toBe(5);

    metrics.reset();
    expect(metrics.snapshot(0).peers.every((p) => p.received === 0)).toBe(true);
  });
});
