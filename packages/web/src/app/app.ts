import { loadCatalogue, findGame, type GameEntry } from "../catalogue";
import { buildMameArgs } from "../core/options";
import { loadBrowserCore } from "../core/browser";
import type { Core } from "../core/types";
import type { GamepadsProvider } from "../input/gamepad";
import type { KeyboardTarget } from "../input/keyboard";
import {
  browserRtcFactory,
  browserWebSocketFactory,
  createMatch,
  defaultIceServers,
  relayConfigFromEnv,
  type IceServer,
  type MatchStatus,
  type NetplayMatch,
  type RtcFactory,
  type WebSocketFactory,
} from "../netplay";
import {
  browserUiDocument,
  renderTree,
  wrapElement,
  type UiDocument,
  type UiElement,
  type ViewNode,
} from "../ui/view";
import { buildList } from "./list-view";
import {
  browserScheduler,
  createPlayController,
  type FrameScheduler,
  type PlayController,
} from "./play-controller";
import { gameHref, startRouter, type Route, type RouterTarget } from "./router";

/**
 * Composition root (T13): route between the catalogue and a play page, booting
 * the core on demand. All browser globals are injected via `AppEnv`, so the
 * wiring is exercised in tests with fakes; `startApp` builds the real env.
 */

/** Relay wiring for netplay routes; injected so tests need no network. */
export interface NetplayEnv {
  relayUrl: string;
  token: string;
  iceServers: IceServer[];
  socketFactory: WebSocketFactory;
  factory: RtcFactory;
  /** Milliseconds clock for the lockstep wait timer; defaults to Date.now. */
  now?: () => number;
}

export interface AppEnv {
  doc: UiDocument;
  /** Container the current view is rendered into (cleared per route). */
  root: UiElement;
  /** Status line element, kept outside `root` so it survives view changes. */
  status: UiElement;
  target: RouterTarget;
  getHash: () => string;
  navigate: (href: string) => void;
  scheduler: FrameScheduler;
  keyboard: KeyboardTarget;
  gamepads: GamepadsProvider;
  /** Set by `startApp`; absent in solo-only tests. */
  netplay?: NetplayEnv;
  /** Generates a fresh room id for "Play online"; defaults to `randomUUID`. */
  newRoomId?: () => string;
}

/** Room id for a new online game. UI-only; never part of the emulation path. */
function defaultRoomId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  return `room-${Date.now().toString(36)}`;
}

export interface LoadCoreOptions {
  /** Arm netplay so the machine freezes at boot and the lockstep drives it. */
  netplay: boolean;
}

export interface AppDeps {
  env: AppEnv;
  games: readonly GameEntry[];
  loadCore: (entry: GameEntry, options: LoadCoreOptions) => Promise<Core>;
}

export interface AppController {
  destroy(): void;
}

function notFound(message: string): { tag: string; className: string; text: string } {
  return { tag: "p", className: "not-found", text: message };
}

/** Minimal lobby bar: the host's manual "Start game" control (T24). */
function lobbyView(onStart: () => void): ViewNode {
  return {
    tag: "div",
    className: "lobby",
    children: [
      {
        tag: "button",
        className: "start-game",
        text: "Start game",
        onClick: onStart,
      },
    ],
  };
}

function matchStatusText(status: MatchStatus): string {
  switch (status) {
    case "connecting":
      return "connecting to room...";
    case "waiting-for-peers":
      return "waiting for players...";
    case "waiting":
      return "waiting for player...";
    case "running":
      return "playing online";
  }
}

export function createApp(deps: AppDeps): AppController {
  let play: PlayController | null = null;
  let match: NetplayMatch | null = null;
  let token = 0;

  const setStatus = (text: string): void => {
    deps.env.status.textContent = text;
  };

  const teardown = (): void => {
    match?.close();
    match = null;
    play?.destroy();
    play = null;
  };

  const render = (route: Route): void => {
    teardown();
    token += 1;
    const myToken = token;
    deps.env.root.textContent = "";
    setStatus("");

    if (route.kind === "list") {
      deps.env.root.append(
        renderTree(
          deps.env.doc,
          buildList(deps.games, {
            onSelect: (driver) => deps.env.navigate(gameHref(driver)),
            onPlayOnline: (driver) =>
              deps.env.navigate(
                gameHref(driver, (deps.env.newRoomId ?? defaultRoomId)()),
              ),
          }),
        ),
      );
      return;
    }

    if (route.kind === "not-found") {
      deps.env.root.append(
        renderTree(deps.env.doc, notFound(`No such page: ${route.path}`)),
      );
      return;
    }

    const entry = findGame(deps.games, route.driver);
    if (!entry) {
      deps.env.root.append(
        renderTree(deps.env.doc, notFound(`Unknown game: ${route.driver}`)),
      );
      return;
    }

    const netplay = deps.env.netplay;
    if (route.room && !netplay) {
      setStatus("online play is not configured (missing relay URL/token)");
      deps.env.root.append(
        renderTree(deps.env.doc, notFound("Online play is not configured")),
      );
      return;
    }

    setStatus(`loading ${entry.title}...`);
    void deps
      .loadCore(entry, { netplay: Boolean(route.room) })
      .then((core) => {
        if (myToken !== token) {
          core.destroy();
          return;
        }
        if (route.room && netplay) {
          match = createMatch({
            core,
            config: {
              relayUrl: netplay.relayUrl,
              token: netplay.token,
              room: route.room,
              role: "player",
              iceServers: netplay.iceServers,
            },
            socketFactory: netplay.socketFactory,
            factory: netplay.factory,
            now: netplay.now ?? (() => Date.now()),
            onStatus: (status) => setStatus(matchStatusText(status)),
          });
        }
        play = createPlayController({
          core,
          entry,
          document: deps.env.doc,
          scheduler: deps.env.scheduler,
          keyboard: deps.env.keyboard,
          gamepads: deps.env.gamepads,
          onStatus: setStatus,
          ...(match ? { lockstep: match } : {}),
        });
        if (match) {
          deps.env.root.append(
            renderTree(
              deps.env.doc,
              lobbyView(() => {
                if (match?.start()) return;
                setStatus(
                  match?.isHost()
                    ? "waiting for players..."
                    : "only the host can start the game",
                );
              }),
            ),
          );
        }
        deps.env.root.append(play.screen);
      })
      .catch((error: unknown) => {
        if (myToken !== token) return;
        setStatus("");
        deps.env.root.append(
          renderTree(
            deps.env.doc,
            notFound(`Failed to load ${entry.title}: ${String(error)}`),
          ),
        );
      });
  };

  const stop = startRouter(deps.env.target, deps.env.getHash, render);
  return {
    destroy: () => {
      token += 1;
      stop();
      teardown();
    },
  };
}

export interface StartOptions {
  catalogueUrl?: string;
  loadGames?: (url: string) => Promise<GameEntry[]>;
  loadCore?: (entry: GameEntry, options: LoadCoreOptions) => Promise<Core>;
  doc?: Document;
  win?: Window;
  /** Overrides the relay wiring; by default it comes from `VITE_RELAY_*`. */
  netplay?: NetplayEnv;
}

/**
 * Directory URL of a driver's core bundle. build-wasm.sh publishes
 * core/out/<driver>/<core_hash>/, so the loadable dir adds coreVersion to the
 * catalogue's driver-level coreBaseUrl (docs/02).
 */
export function coreDirUrl(entry: GameEntry): string {
  return `${entry.coreBaseUrl}/${entry.coreVersion}`;
}

/** Default core loader: fixed args, ROM mounted under `-rompath`. */
function browserCoreLoader(entry: GameEntry, options: LoadCoreOptions): Promise<Core> {
  const romPath = "/roms";
  const sessionPath = "/session";
  return loadBrowserCore({
    coreBaseUrl: coreDirUrl(entry),
    romZipUrl: entry.romZipUrl,
    driver: entry.driver,
    args: buildMameArgs({ driver: entry.driver, romPath, sessionPath }),
    romPath,
    romZipName: `${entry.driver}.zip`,
    netplay: options.netplay,
  });
}

/** Wire the app to real browser globals and the static catalogue. */
export async function startApp(options: StartOptions = {}): Promise<AppController> {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const loadGames = options.loadGames ?? loadCatalogue;
  const loadCore = options.loadCore ?? browserCoreLoader;

  const games = await loadGames(options.catalogueUrl ?? "/games.json");

  const appEl = doc.getElementById("app");
  if (!appEl) throw new Error("startApp: missing #app element");
  const rootEl = doc.createElement("div");
  const statusEl = doc.createElement("p");
  statusEl.className = "status";
  appEl.append(rootEl, statusEl);

  const netplay = options.netplay ?? netplayFromEnv();

  return createApp({
    games,
    loadCore,
    env: {
      doc: browserUiDocument(doc),
      root: wrapElement(rootEl),
      status: wrapElement(statusEl),
      target: win,
      getHash: () => win.location.hash,
      navigate: (href) => {
        win.location.hash = href;
      },
      scheduler: browserScheduler(),
      keyboard: win,
      gamepads: win.navigator,
      ...(netplay ? { netplay } : {}),
    },
  });
}

/**
 * Netplay wiring from Vite build env. `VITE_RELAY_URL` + `VITE_RELAY_TOKEN`
 * win when set; otherwise (dev) the relay defaults to `ws://<page host>:8787/ws`
 * so another machine on the LAN works, and the token may come from a `?token=`
 * query param so each browser can use a distinct dev JWT.
 * (T34 replaces the static dev token with a per-session JWT.)
 */
export function netplayFromEnv(): NetplayEnv | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean> })
    .env ?? {};
  const loc = (globalThis as { location?: { hostname?: string; search?: string } })
    .location;

  const explicit = relayConfigFromEnv({
    ...(typeof env.VITE_RELAY_URL === "string" ? { VITE_RELAY_URL: env.VITE_RELAY_URL } : {}),
    ...(typeof env.VITE_RELAY_TOKEN === "string" ? { VITE_RELAY_TOKEN: env.VITE_RELAY_TOKEN } : {}),
  });
  const relayUrl =
    explicit?.relayUrl ?? (loc?.hostname ? `ws://${loc.hostname}:8787/ws` : undefined);
  const queryToken = loc?.search
    ? new URLSearchParams(loc.search).get("token") ?? undefined
    : undefined;
  const token = explicit?.token ?? (env.DEV ? queryToken : undefined);
  if (!relayUrl || !token) return undefined;

  return {
    relayUrl,
    token,
    iceServers: defaultIceServers(),
    socketFactory: browserWebSocketFactory(),
    factory: browserRtcFactory(),
  };
}
