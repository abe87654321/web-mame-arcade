import type { GameEntry } from "../catalogue";
import type { ViewNode } from "../ui/view";

/**
 * Catalogue list view (T13). Returns a plain tree; the app renders it and maps
 * `onSelect` to navigation (`gameHref`). Keeping it DOM-free means the list can
 * be unit-tested without a browser.
 */

export interface ListViewOptions {
  onSelect: (driver: string) => void;
}

function describe(game: GameEntry): string {
  const players = game.maxPlayers === 1 ? "1 player" : `up to ${game.maxPlayers} players`;
  return `${game.driver} · ${game.netplayMode} · ${players}`;
}

export function buildList(
  games: readonly GameEntry[],
  options: ListViewOptions,
): ViewNode {
  return {
    tag: "div",
    className: "catalogue",
    children: [
      { tag: "h1", text: "Games" },
      ...games.map(
        (game): ViewNode => ({
          tag: "section",
          className: "game",
          children: [
            { tag: "h2", text: game.title },
            { tag: "p", className: "meta", text: describe(game) },
            {
              tag: "button",
              className: "play",
              text: "Play",
              onClick: () => options.onSelect(game.driver),
            },
          ],
        }),
      ),
    ],
  };
}
