import { describe, expect, it } from "vitest";
import { buildScoreboard } from "./scoreboard-view";

describe("buildScoreboard", () => {
  it("renders a row per slot with id, name and score", () => {
    const tree = buildScoreboard([
      { slot: 0, name: "alice", score: 1234 },
      { slot: 1, name: "bob", score: 42 },
    ]);
    expect(tree.tag).toBe("aside");
    expect(tree.className).toBe("scoreboard");
    const rows = tree.children?.[1]?.children ?? [];
    expect(rows).toHaveLength(2);
    const cells = (i: number) => rows[i]?.children?.map((c) => c.text);
    expect(cells(0)).toEqual(["P1", "alice", "1234"]);
    expect(cells(1)).toEqual(["P2", "bob", "42"]);
  });

  it("shows a placeholder when there are no scores", () => {
    const tree = buildScoreboard([]);
    const rows = tree.children?.[1]?.children ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ className: "scoreboard-empty" });
  });

  it("renders an empty name when the roster does not know the slot", () => {
    const tree = buildScoreboard([{ slot: 2, score: 7 }]);
    const cells = tree.children?.[1]?.children?.[0]?.children?.map((c) => c.text);
    expect(cells).toEqual(["P3", "", "7"]);
  });
});
