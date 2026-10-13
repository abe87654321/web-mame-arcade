import type { ViewNode } from "../ui/view";

/**
 * Replay overlay (T35). Returns a plain `ViewNode` tree from a snapshot of the
 * replay's status and progress; the app renders it and maps the controls back to
 * the replay controller. DOM-free, so it is unit-tested without a browser,
 * matching `viewer-view.ts`.
 */

export type ReplayViewStatus =
  | "loading"
  | "playing"
  | "paused"
  | "ended"
  | "error";

export interface ReplayViewPlayer {
  slot: number;
  name: string;
}

export interface ReplayViewState {
  status: ReplayViewStatus;
  /** The game the replay belongs to (from the route/log). */
  driver: string;
  /** Frames stepped so far (the next frame to step). */
  frame: number;
  /** The log's last frame, inclusive. */
  endFrame: number;
  players: readonly ReplayViewPlayer[];
  /** Present when `status === "error"`. */
  error?: string;
}

export interface ReplayViewOptions {
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onLeave: () => void;
}

function statusText(status: ReplayViewStatus): string {
  switch (status) {
    case "loading":
      return "loading replay...";
    case "playing":
      return "playing";
    case "paused":
      return "paused";
    case "ended":
      return "match ended";
    case "error":
      return "error";
  }
}

function playerRow(player: ReplayViewPlayer): ViewNode {
  return {
    tag: "li",
    className: "replay-slot",
    children: [
      { tag: "span", className: "replay-slot__id", text: `P${player.slot + 1}` },
      { tag: "span", className: "replay-slot__name", text: player.name },
    ],
  };
}

export function buildReplay(
  state: ReplayViewState,
  options: ReplayViewOptions,
): ViewNode {
  const paused = state.status === "paused";
  const children: ViewNode[] = [
    {
      tag: "div",
      className: "replay-head",
      children: [
        { tag: "h2", className: "replay-title", text: `Replay · ${state.driver}` },
        {
          tag: "span",
          className: `replay-status ${state.status}`,
          text: statusText(state.status),
        },
      ],
    },
    {
      tag: "div",
      className: "replay-players",
      children: [
        { tag: "div", className: "replay-label", text: "Players" },
        {
          tag: "ul",
          className: "replay-slots",
          children:
            state.players.length > 0
              ? state.players.map(playerRow)
              : [{ tag: "li", className: "replay-empty", text: "no players recorded" }],
        },
      ],
    },
    {
      tag: "div",
      className: "replay-progress",
      text: `${state.frame} / ${state.endFrame}`,
    },
  ];
  if (state.status === "error") {
    children.push({
      tag: "p",
      className: "replay-error",
      text: state.error ?? "failed to load replay",
    });
  }
  children.push({
    tag: "div",
    className: "replay-controls",
    children: [
      {
        tag: "button",
        className: "btn replay-pause",
        text: paused ? "Resume" : "Pause",
        onClick: paused ? options.onResume : options.onPause,
      },
      {
        tag: "button",
        className: "btn replay-restart",
        text: "Restart",
        onClick: options.onRestart,
      },
      {
        tag: "button",
        className: "btn ghost leave",
        text: "Leave",
        onClick: options.onLeave,
      },
    ],
  });
  return { tag: "aside", className: "replay", children };
}
