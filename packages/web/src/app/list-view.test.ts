import { describe, expect, it, vi } from "vitest";
import type { GameEntry } from "../catalogue";
import type { ViewNode } from "../ui/view";
import { buildList } from "./list-view";

const entry: GameEntry = {
  driver: "gridlee",
  title: "Gridlee",
  coreVersion: "a".repeat(64),
  mameCommit: "b".repeat(40),
  supportsSave: true,
  netplayMode: "lockstep",
  maxPlayers: 2,
  romLicensed: true,
  coreBaseUrl: "/static/cores/gridlee",
  romZipUrl: "/roms/gridlee.zip",
};

function findAll(node: ViewNode, className: string): ViewNode[] {
  const hits: ViewNode[] = [];
  if (node.className === className) hits.push(node);
  for (const child of node.children ?? []) {
    hits.push(...findAll(child, className));
  }
  return hits;
}

describe("buildList", () => {
  it("renders one entry per game with its metadata", () => {
    const tree = buildList([entry], { onSelect: vi.fn() });
    const games = findAll(tree, "game");
    expect(games).toHaveLength(1);
    expect(findAll(games[0] as ViewNode, "meta")[0]?.text).toContain("gridlee");
  });

  it("calls onSelect with the driver when Play is clicked", () => {
    const onSelect = vi.fn();
    const tree = buildList([entry], { onSelect });
    const play = findAll(tree, "play")[0] as ViewNode;
    play.onClick?.();
    expect(onSelect).toHaveBeenCalledWith("gridlee");
  });

  it("adds a Play online button for netplay games when wired", () => {
    const onPlayOnline = vi.fn();
    const tree = buildList([entry], { onSelect: vi.fn(), onPlayOnline });
    const online = findAll(tree, "play-online")[0] as ViewNode;
    online.onClick?.();
    expect(onPlayOnline).toHaveBeenCalledWith("gridlee");
  });

  it("omits the Play online button without a handler", () => {
    const tree = buildList([entry], { onSelect: vi.fn() });
    expect(findAll(tree, "play-online")).toHaveLength(0);
  });

  it("omits the Play online button for games without netplay", () => {
    const solo: GameEntry = { ...entry, netplayMode: "none" };
    const tree = buildList([solo], { onSelect: vi.fn(), onPlayOnline: vi.fn() });
    expect(findAll(tree, "play-online")).toHaveLength(0);
  });

  it("renders every game", () => {
    const second: GameEntry = { ...entry, driver: "pacman", title: "Pac-Man" };
    const tree = buildList([entry, second], { onSelect: vi.fn() });
    expect(findAll(tree, "game")).toHaveLength(2);
  });
});
