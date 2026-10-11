import { describe, expect, it, vi } from "vitest";
import type { ViewNode } from "../ui/view";
import { buildViewer, type ViewerViewState } from "./viewer-view";

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

function state(overrides: Partial<ViewerViewState> = {}): ViewerViewState {
  return {
    status: "playing",
    video: false,
    players: [
      { slot: 0, name: "You" },
      { slot: 1, name: "Ryu" },
    ],
    ...overrides,
  };
}

describe("buildViewer", () => {
  it("shows the players and a live status", () => {
    const tree = buildViewer(state(), { onLeave: vi.fn() });
    expect(tree.className).toBe("viewer");
    expect(find(tree, "viewer-status")?.text).toContain("live");
    expect(findAll(tree, "viewer-slot__name").map((node) => node.text)).toEqual([
      "You",
      "Ryu",
    ]);
  });

  it("shows a waiting note with no players yet", () => {
    const tree = buildViewer(state({ players: [] }), { onLeave: vi.fn() });
    expect(find(tree, "viewer-empty")?.text).toBe("waiting for players");
  });

  it("reflects each status", () => {
    const textFor = (status: ViewerViewState["status"]): string | undefined =>
      find(buildViewer(state({ status }), { onLeave: vi.fn() }), "viewer-status")
        ?.text;
    expect(textFor("connecting")).toBe("connecting");
    expect(textFor("buffering")).toBe("buffering");
    expect(textFor("ended")).toBe("match ended");
    expect(textFor("disconnected")).toBe("disconnected");
  });

  it("invokes onLeave from the leave button", () => {
    const onLeave = vi.fn();
    const leave = find(buildViewer(state(), { onLeave }), "leave");
    leave?.onClick?.();
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("flags a live video stream (T41)", () => {
    expect(find(buildViewer(state({ video: false }), { onLeave: vi.fn() }), "viewer-video")).toBeUndefined();
    expect(
      find(buildViewer(state({ video: true }), { onLeave: vi.fn() }), "viewer-video")?.text,
    ).toBe("video");
  });
});
