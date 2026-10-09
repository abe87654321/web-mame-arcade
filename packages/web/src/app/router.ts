/**
 * Tiny hash router (T13). Two views only, so no dependency is justified: the
 * pure `parseRoute` is unit-tested and `startRouter` wires the browser
 * `hashchange` event. Play state lives in the URL (`#/game/<driver>`) so a
 * refresh or a shared link returns to the same game.
 */

export type Route =
  | { kind: "list" }
  | { kind: "play"; driver: string }
  | { kind: "not-found"; path: string };

export interface RouterTarget {
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}

/** Parse a location hash (with or without the leading `#`). */
export function parseRoute(hash: string): Route {
  const path = (hash.startsWith("#") ? hash.slice(1) : hash) || "/";
  if (path === "/") return { kind: "list" };
  const match = /^\/game\/(.+)$/.exec(path);
  if (match?.[1]) return { kind: "play", driver: match[1] };
  return { kind: "not-found", path };
}

export function gameHref(driver: string): string {
  return `#/game/${driver}`;
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
