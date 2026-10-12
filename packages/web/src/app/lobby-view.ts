import type { LobbyState } from "../netplay/match";
import type { ViewNode } from "../ui/view";

/**
 * Lobby overlay view (T27). Returns a plain `ViewNode` tree from a `LobbyState`
 * snapshot; the app renders and re-renders it, and maps the callbacks to the
 * match (start / set ready / leave). Keeping it DOM-free means the whole lobby
 * is unit-tested without a browser, matching `list-view.ts`.
 */

export interface LobbyViewOptions {
  onStart: () => void;
  /** Toggle our own ready flag; the view passes the desired next value. */
  onSetReady: (ready: boolean) => void;
  onLeave: () => void;
  /** Copy/share the live viewer link (T31); omitted in tests without one. */
  onWatch?: () => void;
  /** Host toggles the LiveKit A/V fallback (T41); omitted in tests without it. */
  onToggleVideo?: (enabled: boolean) => void;
}

function statusText(status: LobbyState["roomStatus"]): string {
  switch (status) {
    case "waiting":
      return "waiting for players";
    case "playing":
      return "playing";
    case "ended":
      return "ended";
    case "disconnected":
      return "disconnected";
  }
}

/** Purely visual column headers, aligned to the slot grid (hidden on short screens). */
const SLOT_HEAD: ViewNode = {
  tag: "li",
  className: "slots-head",
  children: [
    { tag: "span", className: "slots-head__col", text: "#" },
    { tag: "span", className: "slots-head__col", text: "name" },
    { tag: "span", className: "slots-head__col", text: "tags" },
    { tag: "span", className: "slots-head__col", text: "state" },
  ],
};

function slotRow(player: LobbyState["players"][number]): ViewNode {
  const tags: ViewNode[] = [];
  if (player.host) tags.push({ tag: "span", className: "tag host", text: "host" });
  if (player.self) tags.push({ tag: "span", className: "tag you", text: "you" });

  // Three lamp states: lit (ready), dark (connected, not ready), amber (connecting).
  const ready = player.ready
    ? { className: "ready on", text: "ready" }
    : player.connected
      ? { className: "ready off", text: "not ready" }
      : { className: "ready off connecting", text: "connecting" };

  const classes = ["lobby-slot"];
  if (player.self) classes.push("self");
  if (!player.connected) classes.push("connecting");

  return {
    tag: "li",
    className: classes.join(" "),
    children: [
      { tag: "span", className: "slot-id", text: `P${player.slot + 1}` },
      { tag: "span", className: "slot-name", text: player.name },
      // Always present so the ready badge keeps its grid column when a row has no tags.
      { tag: "span", className: "slot-tags", children: tags },
      { tag: "span", className: ready.className, text: ready.text },
    ],
  };
}

export function buildLobby(state: LobbyState, options: LobbyViewOptions): ViewNode {
  const self = state.players.find((player) => player.self);
  const controls: ViewNode[] = [];

  if (state.isHost) {
    controls.push({
      tag: "button",
      className: "start-game",
      text: "Start game",
      disabled: !state.canStart,
      onClick: options.onStart,
    });
  } else {
    controls.push({
      tag: "span",
      className: "lobby-hint",
      text: "only the host can start the game",
    });
  }

  if (self) {
    controls.push({
      tag: "button",
      className: "ready-toggle",
      text: self.ready ? "Not ready" : "Ready",
      onClick: () => options.onSetReady(!self.ready),
    });
  }

  // The host can share its screen (canvas + MAME audio) via LiveKit (T41), but
  // only once the match is playing — the relay rejects `video.set` otherwise.
  if (state.isHost && state.roomStatus === "playing" && options.onToggleVideo) {
    controls.push({
      tag: "button",
      className: "video-toggle",
      text: state.video ? "Stop video" : "Share video",
      onClick: () => options.onToggleVideo?.(!state.video),
    });
  }

  if (options.onWatch) {
    controls.push({
      tag: "button",
      className: "watch",
      text: "Watch",
      onClick: options.onWatch,
    });
  }

  controls.push({
    tag: "button",
    className: "btn ghost leave",
    text: "Leave",
    onClick: options.onLeave,
  });

  return {
    tag: "aside",
    className: "lobby",
    children: [
      {
        tag: "div",
        className: "lobby-head",
        children: [
          { tag: "h2", className: "lobby-title", text: "Lobby" },
          {
            tag: "span",
            className: `lobby-status ${state.roomStatus}`,
            text: statusText(state.roomStatus),
          },
          // A collaborative pause (T29): any player paused the room. Shown
          // alongside the room status so it reads as a distinct condition.
          ...(state.paused
            ? [{ tag: "span" as const, className: "lobby-paused", text: "paused" }]
            : []),
        ],
      },
      {
        tag: "div",
        className: "lobby-players",
        children: [
          { tag: "div", className: "lobby-label", text: "Players" },
          {
            tag: "ul",
            className: "lobby-slots",
            children: [SLOT_HEAD, ...state.players.map(slotRow)],
          },
        ],
      },
      { tag: "div", className: "lobby-controls", children: controls },
      {
        tag: "div",
        className: "chat",
        children: [
          { tag: "h3", text: "Chat" },
          { tag: "p", text: "chat coming soon (T30/T36)" },
        ],
      },
    ],
  };
}
