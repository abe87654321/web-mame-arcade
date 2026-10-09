import { loadCatalogue, findGame, type GameEntry } from "../catalogue";
import { buildMameArgs } from "../core/options";
import { loadBrowserCore } from "../core/browser";
import type { Core } from "../core/types";
import type { GamepadsProvider } from "../input/gamepad";
import type { KeyboardTarget } from "../input/keyboard";
import {
  createMatch,
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
}

export interface AppDeps {
  env: AppEnv;
  games: readonly GameEntry[];
  loadCore: (entry: GameEntry) => Promise<Core>;
}

export interface AppController {
  destroy(): void;
}

function notFound(message: string): { tag: string; className: string; text: string } {
  return { tag: "p", className: "not-found", text: message };
}

function matchStatusText(status: MatchStatus): string {
  switch (status) {
    case "connecting":
      return "connecting to room...";
    case "waiting-for-peers":
      return "waiting for players...";
    case "waiting":
      return "waiting for player input...";
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
      .loadCore(entry)
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
  loadCore?: (entry: GameEntry) => Promise<Core>;
  doc?: Document;
  win?: Window;
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
function browserCoreLoader(entry: GameEntry): Promise<Core> {
  const romPath = "/roms";
  const sessionPath = "/session";
  return loadBrowserCore({
    coreBaseUrl: coreDirUrl(entry),
    romZipUrl: entry.romZipUrl,
    driver: entry.driver,
    args: buildMameArgs({ driver: entry.driver, romPath, sessionPath }),
    romPath,
    romZipName: `${entry.driver}.zip`,
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
    },
  });
}
