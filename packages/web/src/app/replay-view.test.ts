import { describe, expect, it, vi } from "vitest";
import type { ViewNode } from "../ui/view";
import {
  buildReplay,
  type ReplayViewOptions,
  type ReplayViewState,
} from "./replay-view";

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

function options(overrides: Partial<ReplayViewOptions> = {}): ReplayViewOptions {
  return {
    onPause: vi.fn(),
    onResume: vi.fn(),
    onRestart: vi.fn(),
    onLeave: vi.fn(),
    ...overrides,
  };
}

function state(overrides: Partial<ReplayViewState> = {}): ReplayViewState {
  return {
    status: "playing",
    driver: "gridlee",
    frame: 120,
    endFrame: 5400,
    players: [
      { slot: 0, name: "alice" },
      { slot: 1, name: "bob" },
    ],
    ...overrides,
  };
}

describe("buildReplay", () => {
  it("shows the driver, players and progress", () => {
    const tree = buildReplay(state(), options());
    expect(tree.className).toBe("replay");
    expect(find(tree, "replay-title")?.text).toContain("gridlee");
    expect(findAll(tree, "replay-slot__name").map((node) => node.text)).toEqual([
      "alice",
      "bob",
    ]);
    expect(find(tree, "replay-progress")?.text).toBe("120 / 5400");
  });

  it("reflects each status", () => {
    const textFor = (status: ReplayViewState["status"]): string | undefined =>
      find(buildReplay(state({ status }), options()), "replay-status")?.text;
    expect(textFor("loading")).toBe("loading replay...");
    expect(textFor("playing")).toBe("playing");
    expect(textFor("paused")).toBe("paused");
    expect(textFor("ended")).toBe("match ended");
  });

  it("clamps progress to the last frame once ended", () => {
    const tree = buildReplay(
      state({ status: "ended", frame: 5401, endFrame: 5400 }),
      options(),
    );
    expect(find(tree, "replay-progress")?.text).toBe("5400 / 5400");
  });

  it("disables the playback controls until a replay exists, and pause once ended", () => {
    const loading = buildReplay(state({ status: "loading" }), options());
    expect(find(loading, "replay-pause")?.disabled).toBe(true);
    expect(find(loading, "replay-restart")?.disabled).toBe(true);

    const playing = buildReplay(state({ status: "playing" }), options());
    expect(find(playing, "replay-pause")?.disabled).toBe(false);
    expect(find(playing, "replay-restart")?.disabled).toBe(false);

    const ended = buildReplay(state({ status: "ended" }), options());
    expect(find(ended, "replay-pause")?.disabled).toBe(true);
    expect(find(ended, "replay-restart")?.disabled).toBe(false);
  });

  it("shows the error message on failure", () => {
    const tree = buildReplay(
      state({ status: "error", error: "core_hash mismatch" }),
      options(),
    );
    expect(find(tree, "replay-error")?.text).toBe("core_hash mismatch");
  });

  it("toggles pause and resume", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const playing = buildReplay(state({ status: "playing" }), options({ onPause, onResume }));
    const pauseBtn = find(playing, "replay-pause");
    expect(pauseBtn?.text).toBe("Pause");
    pauseBtn?.onClick?.();
    expect(onPause).toHaveBeenCalledOnce();
    expect(onResume).not.toHaveBeenCalled();

    const paused = buildReplay(state({ status: "paused" }), options({ onPause, onResume }));
    const resumeBtn = find(paused, "replay-pause");
    expect(resumeBtn?.text).toBe("Resume");
    resumeBtn?.onClick?.();
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("wires restart and leave", () => {
    const onRestart = vi.fn();
    const onLeave = vi.fn();
    const tree = buildReplay(state(), options({ onRestart, onLeave }));
    find(tree, "replay-restart")?.onClick?.();
    expect(onRestart).toHaveBeenCalledOnce();
    find(tree, "leave")?.onClick?.();
    expect(onLeave).toHaveBeenCalledOnce();
  });
});
