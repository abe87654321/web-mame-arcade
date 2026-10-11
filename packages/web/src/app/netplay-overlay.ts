import type { PeerMetrics } from "../netplay/metrics";
import type { ViewNode } from "../ui/view";

/**
 * Dev netplay overlay (T28). Returns a plain `ViewNode` tree from a metrics
 * snapshot; the app renders it (only in a Dev build) over the canvas. DOM-free
 * so it is unit-tested without a browser, matching `lobby-view.ts`.
 */

export interface NetplayOverlayState {
  /** Frame the snapshot was taken at. */
  frame: number;
  /** Client status text (e.g. "playing online", "syncing..."). */
  status: string;
  /** Local frames whose send time was recorded (RTT sample pool). */
  framesSent: number;
  peers: readonly PeerMetrics[];
}

function ms(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}ms`;
}

function peerRow(peer: PeerMetrics): ViewNode {
  return {
    tag: "li",
    className: "netplay-peer",
    children: [
      { tag: "span", className: "netplay-peer__id", text: `P${peer.slot + 1}` },
      { tag: "span", className: "netplay-peer__rtt", text: `rtt ${ms(peer.rttMs)}` },
      {
        tag: "span",
        className: "netplay-peer__jitter",
        text: `jit ${ms(peer.jitterMs)}`,
      },
      {
        tag: "span",
        className: "netplay-peer__loss",
        text: `lost ${peer.lost}/${peer.received}`,
      },
      {
        tag: "span",
        className: "netplay-peer__src",
        text: `p2p ${peer.p2p} · relay ${peer.relay}`,
      },
    ],
  };
}

export function buildNetplayOverlay(state: NetplayOverlayState): ViewNode {
  return {
    tag: "aside",
    className: "netplay-overlay",
    children: [
      {
        tag: "div",
        className: "netplay-head",
        children: [
          { tag: "span", className: "netplay-title", text: "netplay" },
          { tag: "span", className: "netplay-status", text: state.status },
        ],
      },
      {
        tag: "div",
        className: "netplay-frame",
        text: `frame ${state.frame} · sent ${state.framesSent}`,
      },
      {
        tag: "ul",
        className: "netplay-peers",
        children:
          state.peers.length > 0
            ? state.peers.map(peerRow)
            : [{ tag: "li", className: "netplay-empty", text: "no peers" }],
      },
    ],
  };
}
