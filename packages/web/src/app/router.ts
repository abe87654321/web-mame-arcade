/**
 * Tiny hash router (T13). Two views only, so no dependency is justified: the
 * pure `parseRoute` is unit-tested and `startRouter` wires the browser
 * `hashchange` event. Play state lives in the URL (`#/game/<driver>`) so a
 * refresh or a shared link returns to the same game.
 */

export type Route =
  | { kind: "list" }
  | { kind: "play"; driver: string; room: string | null }
  | { kind: "watch"; driver: string; room: string }
  | { kind: "replay"; driver: string; key: string }
  | { kind: "not-found"; path: string };

export interface RouterTarget {
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}

/** Parse a location hash (with or without the leading `#`). */
export function parseRoute(hash: string): Route {
  const path = (hash.startsWith("#") ? hash.slice(1) : hash) || "/";
  if (path === "/") return { kind: "list" };
  const match =
    /^\/game\/([^/]+)(?:\/room\/([^/]+)(\/watch)?|\/replay\/([^/]+))?$/.exec(path);
  if (match?.[1]) {
    if (match[2]) {
      return match[3]
        ? { kind: "watch", driver: match[1], room: match[2] }
        : { kind: "play", driver: match[1], room: match[2] };
    }
    if (match[4]) {
      return { kind: "replay", driver: match[1], key: decodeReplayKey(match[4]) };
    }
    return { kind: "play", driver: match[1], room: null };
  }
  return { kind: "not-found", path };
}

/**
 * The replay key segment is URL-encoded because it contains slashes
 * (`match/<room>/<id>.json.gz`); decode it for the app, tolerating a malformed
 * escape rather than throwing out of the router.
 */
function decodeReplayKey(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Play link; with a room it joins netplay, without it is solo (T24). */
export function gameHref(driver: string, room?: string): string {
  return room ? `#/game/${driver}/room/${room}` : `#/game/${driver}`;
}

/** Viewer link for a room (T31): `#/game/<driver>/room/<room>/watch`. */
export function watchHref(driver: string, room: string): string {
  return `#/game/${driver}/room/${room}/watch`;
}

/** Replay link for a closed match (T35): `#/game/<driver>/replay/<key>`. */
export function replayHref(driver: string, key: string): string {
  return `#/game/${driver}/replay/${encodeURIComponent(key)}`;
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
