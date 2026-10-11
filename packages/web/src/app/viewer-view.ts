import type { ViewNode } from "../ui/view";

/**
 * Viewer overlay (T31). Returns a plain `ViewNode` tree from a snapshot of the
 * viewer's status and the seated roster; the app renders it and maps Leave back
 * to navigation. DOM-free, so it is unit-tested without a browser, matching
 * `lobby-view.ts`.
 */

export interface ViewerPlayer {
  slot: number;
  name: string;
}

export interface ViewerViewState {
  status:
    | "connecting"
    | "buffering"
    | "playing"
    | "ended"
    | "disconnected";
  players: readonly ViewerPlayer[];
  /** The host is sharing A/V and we have a live video stream (T41). */
  video: boolean;
}

export interface ViewerViewOptions {
  onLeave: () => void;
}

/** Buffer the viewer holds behind live (docs/04: 2-5 s). */
const BEHIND_SECONDS = 3;

function statusText(status: ViewerViewState["status"]): string {
  switch (status) {
    case "connecting":
      return "connecting";
    case "buffering":
      return "buffering";
    case "playing":
      return `live · ${BEHIND_SECONDS} s behind`;
    case "ended":
      return "match ended";
    case "disconnected":
      return "disconnected";
  }
}

function playerRow(player: ViewerPlayer): ViewNode {
  return {
    tag: "li",
    className: "viewer-slot",
    children: [
      { tag: "span", className: "viewer-slot__id", text: `P${player.slot + 1}` },
      { tag: "span", className: "viewer-slot__name", text: player.name },
    ],
  };
}

export function buildViewer(
  state: ViewerViewState,
  options: ViewerViewOptions,
): ViewNode {
  const headChildren: ViewNode[] = [
    { tag: "h2", className: "viewer-title", text: "Live" },
    {
      tag: "span",
      className: `viewer-status ${state.status}`,
      text: statusText(state.status),
    },
  ];
  if (state.video) {
    headChildren.push({ tag: "span", className: "viewer-video", text: "video" });
  }
  return {
    tag: "aside",
    className: "viewer",
    children: [
      {
        tag: "div",
        className: "viewer-head",
        children: headChildren,
      },
      {
        tag: "div",
        className: "viewer-players",
        children: [
          { tag: "div", className: "viewer-label", text: "Players" },
          {
            tag: "ul",
            className: "viewer-slots",
            children:
              state.players.length > 0
                ? state.players.map(playerRow)
                : [{ tag: "li", className: "viewer-empty", text: "waiting for players" }],
          },
        ],
      },
      {
        tag: "div",
        className: "viewer-controls",
        children: [
          {
            tag: "button",
            className: "btn ghost leave",
            text: "Leave",
            onClick: options.onLeave,
          },
        ],
      },
    ],
  };
}
