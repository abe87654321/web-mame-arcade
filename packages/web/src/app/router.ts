/**
 * Tiny hash router (T13). Two views only, so no dependency is justified: the
 * pure `parseRoute` is unit-tested and `startRouter` wires the browser
 * `hashchange` event. Play state lives in the URL (`#/game/<driver>`) so a
 * refresh or a shared link returns to the same game.
 */

export type Route =
  | { kind: "list" }
  | { kind: "play"; driver: string; room: string | null }
  | { kind: "not-found"; path: string };

export interface RouterTarget {
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}

/** Parse a location hash (with or without the leading `#`). */
export function parseRoute(hash: string): Route {
  const path = (hash.startsWith("#") ? hash.slice(1) : hash) || "/";
  if (path === "/") return { kind: "list" };
  const match = /^\/game\/([^/]+)(?:\/room\/([^/]+))?$/.exec(path);
  if (match?.[1]) {
    const room = match[2] ?? null;
    return { kind: "play", driver: match[1], room };
  }
  return { kind: "not-found", path };
}

/** Play link; with a room it joins netplay, without it is solo (T24). */
export function gameHref(driver: string, room?: string): string {
  return room ? `#/game/${driver}/room/${room}` : `#/game/${driver}`;
}

/**
 * Emit the current route immediately, then on every hashchange. Returns a
 * detach function. `getHash` is injected so tests need no real window.
 */
export function startRouter(
  target: RouterTarget,
  getHash: () => string,
  onChange: (route: Route) => void,
): () => void {
  const emit = (): void => onChange(parseRoute(getHash()));
  target.addEventListener("hashchange", emit);
  emit();
  return () => target.removeEventListener("hashchange", emit);
}
