import { describe, expect, it, vi } from "vitest";
import type { LobbyState } from "../netplay/match";
import type { ViewNode } from "../ui/view";
import { buildLobby } from "./lobby-view";

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

function state(overrides: Partial<LobbyState> = {}): LobbyState {
  return {
    roomStatus: "waiting",
    isHost: true,
    canStart: false,
    players: [
      { slot: 0, name: "You", host: true, self: true, connected: true, ready: false },
      { slot: 1, name: "Ryu", host: false, self: false, connected: true, ready: false },
    ],
    ...overrides,
  };
}

function options() {
  return { onStart: vi.fn(), onSetReady: vi.fn(), onLeave: vi.fn() };
}

describe("buildLobby", () => {
  it("renders one slot row per player with name, host and self markers", () => {
    const tree = buildLobby(state(), options());
    const slots = findAll(tree, "lobby-slot");
    expect(slots).toHaveLength(2);
    expect(slots[0]?.children?.some((c) => c.text === "You")).toBe(true);
    expect(find(tree, "lobby-status")?.text).toBe("waiting for players");
  });

  it("disables the host start button until canStart", () => {
    const disabled = find(buildLobby(state({ canStart: false }), options()), "start-game");
    expect(disabled?.disabled).toBe(true);
    const enabled = find(buildLobby(state({ canStart: true }), options()), "start-game");
    expect(enabled?.disabled).toBe(false);
  });

  it("shows the start button only to the host", () => {
    const host = buildLobby(state({ isHost: true }), options());
    expect(find(host, "start-game")).toBeDefined();
    const guest = buildLobby(state({ isHost: false }), options());
    expect(find(guest, "start-game")).toBeUndefined();
    expect(find(guest, "lobby-hint")?.text).toContain("host");
  });

  it("toggles ready from the self player's current flag", () => {
    const opts = options();
    const tree = buildLobby(state(), opts);
    const ready = find(tree, "ready-toggle");
    expect(ready?.text).toBe("Ready");
    ready?.onClick?.();
    expect(opts.onSetReady).toHaveBeenCalledWith(true);

    const readyNow = buildLobby(
      state({
        players: [
          { slot: 0, name: "You", host: true, self: true, connected: true, ready: true },
        ],
      }),
      options(),
    );
    expect(find(readyNow, "ready-toggle")?.text).toBe("Not ready");
  });

  it("calls onStart and onLeave from their buttons", () => {
    const opts = options();
    const tree = buildLobby(state({ canStart: true }), opts);
    find(tree, "start-game")?.onClick?.();
    find(tree, "leave")?.onClick?.();
    expect(opts.onStart).toHaveBeenCalledOnce();
    expect(opts.onLeave).toHaveBeenCalledOnce();
  });

  it("shows a chat placeholder and the room status", () => {
    const tree = buildLobby(state({ roomStatus: "playing" }), options());
    expect(find(tree, "chat")).toBeDefined();
    expect(find(tree, "lobby-status")?.text).toBe("playing");
    const gone = buildLobby(state({ roomStatus: "disconnected" }), options());
    expect(find(gone, "lobby-status")?.text).toBe("disconnected");
  });
});
