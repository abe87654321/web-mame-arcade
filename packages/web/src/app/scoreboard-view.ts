import type { ViewNode } from "../ui/view";

/**
 * Live scoreboard overlay (T32). Returns a plain `ViewNode` tree from the
 * latest per-slot scores; the app renders and re-renders it for both players
 * and viewers. DOM-free, so it is unit-tested without a browser, matching
 * `lobby-view.ts`.
 */

export interface ScoreboardRow {
  slot: number;
  score: number;
  /** Display name, when the roster knows it. */
  name?: string;
}

function row(row: ScoreboardRow): ViewNode {
  return {
    tag: "li",
    className: "scoreboard-slot",
    children: [
      { tag: "span", className: "scoreboard-slot__id", text: `P${row.slot + 1}` },
      { tag: "span", className: "scoreboard-slot__name", text: row.name ?? "" },
      {
        tag: "span",
        className: "scoreboard-slot__score",
        text: String(row.score),
      },
    ],
  };
}

export function buildScoreboard(rows: readonly ScoreboardRow[]): ViewNode {
  return {
    tag: "aside",
    className: "scoreboard",
    children: [
      {
        tag: "div",
        className: "scoreboard-head",
        children: [{ tag: "span", className: "scoreboard-title", text: "Score" }],
      },
      {
        tag: "ul",
        className: "scoreboard-slots",
        children:
          rows.length > 0
            ? rows.map(row)
            : [{ tag: "li", className: "scoreboard-empty", text: "no scores yet" }],
      },
    ],
  };
}
