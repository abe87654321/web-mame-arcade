import { describe, expect, it } from "vitest";
import type { ViewNode } from "../ui/view";
import { buildNetplayOverlay, type NetplayOverlayState } from "./netplay-overlay";

function find(node: ViewNode, className: string): ViewNode | undefined {
  if (node.className?.split(" ").includes(className)) return node;
  for (const child of node.children ?? []) {
    const found = find(child, className);
    if (found) return found;
  }
  return undefined;
}

function findAll(node: ViewNode, className: string): ViewNode[] {
  const out: ViewNode[] = [];
  if (node.className?.split(" ").includes(className)) out.push(node);
  for (const child of node.children ?? []) out.push(...findAll(child, className));
  return out;
}

function state(overrides: Partial<NetplayOverlayState> = {}): NetplayOverlayState {
  return {
    frame: 120,
    status: "playing online",
    framesSent: 122,
    peers: [
      {
        slot: 1,
        rttMs: 42.4,
        jitterMs: 3.2,
        lost: 1,
        received: 120,
        p2p: 118,
        relay: 2,
      },
    ],
    ...overrides,
  };
}

describe("buildNetplayOverlay", () => {
  it("shows the frame, status and sent count", () => {
    const tree = buildNetplayOverlay(state());
    expect(find(tree, "netplay-status")?.text).toBe("playing online");
    expect(find(tree, "netplay-frame")?.text).toBe("frame 120 · sent 122");
  });

  it("renders one row per peer with rtt, jitter, loss and source counts", () => {
    const tree = buildNetplayOverlay(state());
    const rows = findAll(tree, "netplay-peer");
    expect(rows).toHaveLength(1);
    expect(find(rows[0]!, "netplay-peer__rtt")?.text).toBe("rtt 42ms");
    expect(find(rows[0]!, "netplay-peer__jitter")?.text).toBe("jit 3ms");
    expect(find(rows[0]!, "netplay-peer__loss")?.text).toBe("lost 1/120");
    expect(find(rows[0]!, "netplay-peer__src")?.text).toBe("p2p 118 · relay 2");
  });

  it("shows a dash for a peer with no samples yet", () => {
    const tree = buildNetplayOverlay(
      state({
        peers: [
          {
            slot: 1,
            rttMs: null,
            jitterMs: null,
            lost: 0,
            received: 0,
            p2p: 0,
            relay: 0,
          },
        ],
      }),
    );
    expect(find(tree, "netplay-peer__rtt")?.text).toBe("rtt —");
  });

  it("says so when there are no peers", () => {
    const tree = buildNetplayOverlay(state({ peers: [] }));
    expect(find(tree, "netplay-empty")?.text).toBe("no peers");
  });
});
