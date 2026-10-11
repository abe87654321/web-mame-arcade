/**
 * Netplay connection metrics (T28). Pure and clock-injected: it turns the input
 * stream into the numbers the dev overlay and adaptive-delay input need — per-peer
 * RTT (from the packet `ack_frame`), inter-arrival jitter, gap-counted loss and a
 * P2P-vs-relay source tally (docs/contracts/input-packet.md).
 *
 * Determinism: this is telemetry only. The injected `now()` never reaches
 * `core.step`, so a clock reading can never make two peers diverge.
 */

export type PacketSource = "p2p" | "relay";

/** The diagnostic fields of a decoded input packet. */
export interface PacketView {
  /** Highest frame the sender has received from us (docs/contracts). */
  ackFrame: number;
  /** Frame of the packet's oldest carried input. */
  firstFrame: number;
}

export interface PeerMetrics {
  slot: number;
  /** Latest measured round-trip time in ms, or null until an ack lands. */
  rttMs: number | null;
  /** Smoothed inter-arrival deviation in ms, or null with < 2 packets. */
  jitterMs: number | null;
  /** Packets implied missing by gaps in the peer's `firstFrame` series. */
  lost: number;
  received: number;
  p2p: number;
  relay: number;
}

export interface MetricsSnapshot {
  /** The simulated frame this snapshot was taken at (informational). */
  frame: number;
  /** Local frames whose send time was recorded (the RTT sample pool). */
  framesSent: number;
  /** Every peer except our own slot, in ascending slot order. */
  peers: PeerMetrics[];
}

export interface MetricsDeps {
  mySlot: number;
  players: readonly number[];
  now: () => number;
}

export interface Metrics {
  /** Record when our own `frame` was scheduled, for a later RTT sample. */
  noteLocalFrame(frame: number, at?: number): void;
  /** Feed one decoded packet received from `player` over `source`. */
  onPeerPacket(
    player: number,
    packet: PacketView,
    source: PacketSource,
    at?: number,
  ): void;
  snapshot(frame: number): MetricsSnapshot;
  reset(): void;
}

interface PeerState {
  rttMs: number | null;
  jitterMs: number | null;
  lost: number;
  received: number;
  p2p: number;
  relay: number;
  highestFirst: number;
  lastArrival: number | null;
  lastDelta: number | null;
}

/** Keep at most this many local frame send-times (older acks are forgotten). */
const SENT_WINDOW = 512;
const JITTER_SMOOTHING = 0.9;

function freshPeer(): PeerState {
  return {
    rttMs: null,
    jitterMs: null,
    lost: 0,
    received: 0,
    p2p: 0,
    relay: 0,
    highestFirst: -1,
    lastArrival: null,
    lastDelta: null,
  };
}

export function createMetrics(deps: MetricsDeps): Metrics {
  const peers = new Map<number, PeerState>();
  /** frame -> local wall-clock time it was scheduled (insertion ordered). */
  const sentAt = new Map<number, number>();
  let framesSent = 0;

  function ensure(player: number): PeerState {
    let state = peers.get(player);
    if (!state) {
      state = freshPeer();
      peers.set(player, state);
    }
    return state;
  }

  function pruneSent(): void {
    if (sentAt.size <= SENT_WINDOW) return;
    const excess = sentAt.size - SENT_WINDOW;
    let n = 0;
    for (const frame of sentAt.keys()) {
      sentAt.delete(frame);
      if (++n >= excess) break;
    }
  }

  return {
    noteLocalFrame(frame: number, at?: number): void {
      sentAt.set(frame, at ?? deps.now());
      framesSent += 1;
      pruneSent();
    },

    onPeerPacket(player, packet, source, at?: number): void {
      if (player === deps.mySlot) return;
      const nowAt = at ?? deps.now();
      const state = ensure(player);
      state.received += 1;
      if (source === "p2p") state.p2p += 1;
      else state.relay += 1;

      // Loss: a strictly forward jump means packets that never arrived as new
      // data. Reordered/overlapping packets never move `highestFirst` backwards,
      // so they are not miscounted as loss.
      if (
        state.highestFirst >= 0 &&
        packet.firstFrame > state.highestFirst + 1
      ) {
        state.lost += packet.firstFrame - state.highestFirst - 1;
      }
      if (packet.firstFrame > state.highestFirst) {
        state.highestFirst = packet.firstFrame;
      }

      // RTT: the peer's ack names one of our frames; we timed when we sent it.
      const sent = sentAt.get(packet.ackFrame);
      if (sent !== undefined && nowAt >= sent) {
        state.rttMs = nowAt - sent;
      }

      // Jitter: smoothed deviation of inter-arrival gaps.
      if (state.lastArrival !== null) {
        const delta = nowAt - state.lastArrival;
        if (state.lastDelta !== null) {
          const deviation = Math.abs(delta - state.lastDelta);
          state.jitterMs =
            state.jitterMs === null
              ? deviation
              : state.jitterMs * JITTER_SMOOTHING +
                deviation * (1 - JITTER_SMOOTHING);
        }
        state.lastDelta = delta;
      }
      state.lastArrival = nowAt;
    },

    snapshot(frame: number): MetricsSnapshot {
      const list: PeerMetrics[] = [];
      for (const slot of [...deps.players].sort((a, b) => a - b)) {
        if (slot === deps.mySlot) continue;
        const state = peers.get(slot);
        list.push({
          slot,
          rttMs: state?.rttMs ?? null,
          jitterMs: state?.jitterMs ?? null,
          lost: state?.lost ?? 0,
          received: state?.received ?? 0,
          p2p: state?.p2p ?? 0,
          relay: state?.relay ?? 0,
        });
      }
      return { frame, framesSent, peers: list };
    },

    reset(): void {
      peers.clear();
      sentAt.clear();
      framesSent = 0;
    },
  };
}
