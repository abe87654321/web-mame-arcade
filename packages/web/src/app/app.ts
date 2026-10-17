import { decodeInputLog, type InputLog } from "@wma/protocol";
import { loadCatalogue, findGame, type GameEntry } from "../catalogue";
import { gunzip } from "../core";
import { buildMameArgs } from "../core/options";
import { loadBrowserCore } from "../core/browser";
import type { Core } from "../core/types";
import type { GamepadEventTarget, GamepadsProvider } from "../input/gamepad";
import { createInputSetup, type InputSetup } from "../input/setup";
import type { KeyboardTarget } from "../input/keyboard";
import type { StorageLike } from "../input/remap";
import {
  browserRtcFactory,
  browserWebSocketFactory,
  createMatch,
  createReplay,
  createViewer,
  createVideoPublisher,
  createVideoSubscriber,
  defaultIceServers,
  liveKitFactoryFromEnv,
  relayConfigFromEnv,
  type IceServer,
  type LiveKitFactory,
  type LobbyState,
  type MatchStatus,
  type NetplayMatch,
  type Replay,
  type RtcFactory,
  type Viewer,
  type WebSocketFactory,
} from "../netplay";
import { installAudioCapture, type AudioCaptureEnv } from "../audio/capture";
import {
  browserUiDocument,
  renderTree,
  wrapElement,
  type UiDocument,
  type UiElement,
} from "../ui/view";
import { buildList } from "./list-view";
import { buildLobby } from "./lobby-view";
import { buildNetplayOverlay } from "./netplay-overlay";
import { buildReplay, type ReplayViewState } from "./replay-view";
import { buildScoreboard } from "./scoreboard-view";
import {
  browserScheduler,
  createPlayController,
  type FrameScheduler,
  type PlayController,
} from "./play-controller";
import { gameHref, startRouter, watchHref, type Route, type RouterTarget } from "./router";
import { buildViewer, type ViewerViewState } from "./viewer-view";
import { readInputScript } from "./test-input";

/**
 * Resolve the netplay loop a catalogue entry asks for (T40). The catalogue flag
 * wins in production; the dev/e2e hook can force rollback for testing a driver
 * that has not passed the per-driver budget gate yet.
 */
export function rollbackConfig(
  entry: GameEntry,
  env: { forceRollback?: boolean },
): { rollback: boolean; rollbackWindow?: number } {
  return {
    rollback: entry.netplayMode === "rollback" || env.forceRollback === true,
    ...(entry.rollbackWindow !== undefined
      ? { rollbackWindow: entry.rollbackWindow }
      : {}),
  };
}

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
  /**
   * Per-session input wiring (device assignment + hot-plug + Controls panel);
   * set by `startApp`. Absent in solo-only tests, which use the default config.
   */
  inputSetup?: InputSetup;
  /** Set by `startApp`; absent in solo-only tests. */
  netplay?: NetplayEnv;
  /** Render the dev netplay metrics overlay (T28); set by `startApp` in Dev. */
  devOverlay?: boolean;
  /** Generates a fresh room id for "Play online"; defaults to `randomUUID`. */
  newRoomId?: () => string;
  /**
   * Deterministic per-slot input for the netplay e2e harness (T26); set from
   * `window.__WMA_TEST_INPUT__` by `startApp`. Absent in normal play.
   */
  inputScript?: (slot: number, frame: number) => number;
  /**
   * Dev/e2e only: force rollback even when the catalogue says lockstep (T40).
   * Set from `window.__WMA_TEST_ROLLBACK__` by `startApp`.
   */
  forceRollback?: boolean;
  /**
   * Page-visibility source for the collaborative pause (T29). `startApp`
   * wires it to `document`; tests omit it, so no listener is attached.
   */
  visibility?: {
    /** Whether the page is currently hidden/occluded. */
    hidden(): boolean;
    /** Subscribe to visibility changes; returns an unsubscribe. */
    onChange(listener: () => void): () => void;
  };
  /** The shared canvas MAME renders into; set by `startApp`, absent in tests. */
  screen?: HTMLCanvasElement;
  /** LiveKit room factory for the A/V fallback (T41); set by `startApp`. */
  liveKit?: LiveKitFactory;
  /** Tapped MAME audio for the host publisher (T41); set by `startApp`. */
  getAudioStream?: () => MediaStream | null;
  /**
   * Attach/detach the viewer's remote A/V stream (T41); set by `startApp` with
   * a real `<video>` element, absent in tests.
   */
  attachVideo?: (stream: MediaStream | null) => void;
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
  /** The canvas MAME renders into; must be in the DOM before boot. */
  canvas?: unknown;
}

export interface AppDeps {
  env: AppEnv;
  games: readonly GameEntry[];
  loadCore: (entry: GameEntry, options: LoadCoreOptions) => Promise<Core>;
  /**
   * Fetch a closed match's gzip input-log artifact for the replay route (T35).
   * Wired to `GET /api/replays/<key>` by `startApp`; absent when the API is not
   * configured, in which case the replay route shows an error.
   */
  loadReplay?: (key: string) => Promise<Uint8Array>;
}

export interface AppController {
  destroy(): void;
}

function notFound(message: string): { tag: string; className: string; text: string } {
  return { tag: "p", className: "not-found", text: message };
}

export function matchStatusText(status: MatchStatus): string {
  switch (status) {
    case "connecting":
      return "connecting to room...";
    case "waiting-for-peers":
      return "waiting for players...";
    // A lockstep stall mid-match: the next frame's input is late. This is not
    // the lobby wait and must read differently, or a brief network hiccup looks
    // like a broken game (T31 field note).
    case "waiting":
      return "syncing...";
    case "running":
      return "playing online";
    // A collaborative pause (T29): any player's tab is hidden/away.
    case "paused":
      return "paused";
  }
}

/**
 * A replay may only run on the exact core the match used (docs/contracts/
 * core-version.md): a different core_hash/rom_hash/mame_commit is a guaranteed
 * false replay, so refuse it instead of stepping.
 */
export function assertReplayIdentity(entry: GameEntry, log: InputLog): void {
  if (log.meta.driver !== entry.driver) {
    throw new Error(`replay is for ${log.meta.driver}, not ${entry.driver}`);
  }
  if (log.meta.core_hash !== entry.coreVersion) {
    throw new Error("replay core hash does not match the catalogue");
  }
  if (log.meta.rom_hash !== entry.romHash) {
    throw new Error("replay ROM hash does not match the catalogue");
  }
  if (log.meta.mame_commit !== entry.mameCommit) {
    throw new Error("replay MAME commit does not match the catalogue");
  }
}

export function createApp(deps: AppDeps): AppController {
  let play: PlayController | null = null;
  let match: NetplayMatch | null = null;
  let viewer: Viewer | null = null;
  let viewerHandle: number | null = null;
  let replay: Replay | null = null;
  let replayHandle: number | null = null;
  let detachVisibility: (() => void) | null = null;
  let inputHudTimer: ReturnType<typeof setInterval> | null = null;
  let token = 0;

  const setStatus = (text: string): void => {
    deps.env.status.textContent = text;
  };

  /**
   * Render the live scoreboard overlay (T32) into `host`, joining each score to
   * the roster name for its slot. Display only; the app re-renders it on every
   * score change for players and viewers.
   */
  const renderScores = (
    host: UiElement,
    rows: readonly { slot: number; score: number }[],
    names: ReadonlyMap<number, string>,
  ): void => {
    host.textContent = "";
    host.append(
      renderTree(
        deps.env.doc,
        buildScoreboard(rows.map((row) => ({ ...row, name: names.get(row.slot) }))),
      ),
    );
  };

  const teardown = (): void => {
    if (inputHudTimer !== null) {
      clearInterval(inputHudTimer);
      inputHudTimer = null;
    }
    detachVisibility?.();
    detachVisibility = null;
    match?.close();
    match = null;
    if (viewerHandle !== null) {
      deps.env.scheduler.cancel(viewerHandle);
      viewerHandle = null;
    }
    viewer?.close();
    viewer = null;
    if (replayHandle !== null) {
      deps.env.scheduler.cancel(replayHandle);
      replayHandle = null;
    }
    replay?.destroy();
    replay = null;
    play?.destroy();
    play = null;
  };

  const now = (): number => (deps.env.netplay?.now ?? (() => Date.now()))();

  /**
   * Mount the live viewer (T31): join the room as a viewer, boot the frozen core
   * (already loaded), render the viewer overlay and drive `viewer.tick` from the
   * frame scheduler. `core` is owned by the viewer controller from here.
   */
  const startViewer = (
    core: Core,
    entry: GameEntry,
    room: string,
    netplay: NetplayEnv,
  ): void => {
    const host = deps.env.doc.createElement("div");
    host.className = "viewer-host";
    // Live scoreboard overlay for the viewer (T32); names come from the roster.
    const scoreboardHost = deps.env.doc.createElement("div");
    scoreboardHost.className = "scoreboard-host";
    let state: ViewerViewState = { status: "connecting", players: [], video: false };
    const renderViewer = (): void => {
      host.textContent = "";
      host.append(
        renderTree(
          deps.env.doc,
          buildViewer(state, { onLeave: () => deps.env.navigate("#/") }),
        ),
      );
    };
    // The A/V subscriber (T41) is created only when a LiveKit factory is wired;
    // the viewer controller drives it from the relay's `livekit.access`.
    const video = deps.env.liveKit
      ? createVideoSubscriber({
          factory: deps.env.liveKit,
          log: (event, fields) => console.warn("[viewer]", event, fields),
        })
      : undefined;
    viewer = createViewer({
      core,
      config: { relayUrl: netplay.relayUrl, token: netplay.token, room },
      socketFactory: netplay.socketFactory,
      now: netplay.now ?? (() => Date.now()),
      onStatus: (status) => {
        state = { ...state, status };
        renderViewer();
      },
      onPlayers: (players) => {
        state = { ...state, players };
        renderViewer();
      },
      onScores: (rows) =>
        renderScores(
          scoreboardHost,
          rows,
          new Map(state.players.map((player) => [player.slot, player.name])),
        ),
      ...(video ? { video } : {}),
      onVideo: (stream) => {
        deps.env.attachVideo?.(stream);
        state = { ...state, video: stream !== null };
        renderViewer();
      },
      log: (event, fields) => console.warn("[viewer]", event, fields),
    });
    renderViewer();
    deps.env.root.append(host);
    deps.env.root.append(scoreboardHost);
    setStatus(`watching ${entry.title}`);
    const loop = (): void => {
      viewer?.tick(now());
      viewerHandle = deps.env.scheduler.request(loop);
    };
    viewerHandle = deps.env.scheduler.request(loop);
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

    // Replay route (T35): fetch the closed log, verify it against the catalogue
    // entry, then replay it on a frozen core. Needs no relay, so it is handled
    // before the room/netplay guard.
    if (route.kind === "replay") {
      const replayScreen = deps.env.screen ? wrapElement(deps.env.screen) : null;
      if (replayScreen) deps.env.root.append(replayScreen);
      const host = deps.env.doc.createElement("div");
      host.className = "replay-host";
      let state: ReplayViewState = {
        status: "loading",
        driver: entry.driver,
        frame: 0,
        endFrame: 0,
        players: [],
      };
      const renderReplay = (): void => {
        host.textContent = "";
        host.append(
          renderTree(
            deps.env.doc,
            buildReplay(state, {
              onPause: () => replay?.pause(),
              onResume: () => replay?.play(),
              onRestart: () => replay?.restart(),
              onLeave: () => deps.env.navigate("#/"),
            }),
          ),
        );
      };
      renderReplay();
      deps.env.root.append(host);
      setStatus(`loading ${entry.title} replay...`);
      const loadReplay = deps.loadReplay;
      if (!loadReplay) {
        state = { ...state, status: "error", error: "replay loading is not configured" };
        renderReplay();
        return;
      }
      void loadReplay(route.key)
        .then(async (bytes) => {
          const log = decodeInputLog(await gunzip(bytes));
          assertReplayIdentity(entry, log);
          const core = await deps.loadCore(entry, {
            netplay: true,
            ...(deps.env.screen ? { canvas: deps.env.screen } : {}),
          });
          if (myToken !== token) {
            core.destroy();
            return;
          }
          replay = createReplay({
            core,
            log,
            onStatus: (status) => {
              state = { ...state, status };
              renderReplay();
            },
            onProgress: ({ frame, endFrame }) => {
              state = { ...state, frame, endFrame };
              renderReplay();
            },
          });
          state = {
            ...state,
            status: replay.status(),
            frame: replay.frame(),
            endFrame: replay.endFrame(),
            players: log.start.players.map((player) => ({
              slot: player.slot,
              name: player.name,
            })),
          };
          renderReplay();
          setStatus(`replaying ${entry.title}`);
          const loop = (): void => {
            replay?.tick(now());
            replayHandle = deps.env.scheduler.request(loop);
          };
          replayHandle = deps.env.scheduler.request(loop);
        })
        .catch((error: unknown) => {
          if (myToken !== token) return;
          setStatus("");
          state = { ...state, status: "error", error: String(error) };
          renderReplay();
        });
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

    // The canvas must be in the DOM before the core boots (SDL creates the
    // WebGL context during runtime init), so mount it first, then load.
    const screenUi = deps.env.screen ? wrapElement(deps.env.screen) : null;
    if (screenUi) deps.env.root.append(screenUi);

    // Controls panel (T12): assign a keyboard/gamepad per player and rebind
    // keys. Present on every play route; re-rendered after any in-panel action.
    const inputSetup = deps.env.inputSetup;
    if (inputSetup && route.kind === "play") {
      const panel = deps.env.doc.createElement("div");
      panel.className = "controls-host";
      const toggle = deps.env.doc.createElement("button");
      toggle.className = "controls-toggle";
      toggle.textContent = "Controls";
      const body = deps.env.doc.createElement("div");
      body.className = "controls-body";
      const rerender = (): void => {
        body.textContent = "";
        body.append(renderTree(deps.env.doc, inputSetup.ui.view()));
      };
      rerender();
      toggle.addEventListener("click", () => {
        body.className =
          body.className.indexOf("open") === -1
            ? "controls-body open"
            : "controls-body";
      });
      body.addEventListener("click", () => {
        setTimeout(rerender, 0);
      });
      panel.append(toggle);
      panel.append(body);
      deps.env.root.append(panel);
    }

    // The lobby overlay is a fixed-position element the match re-renders from
    // its `onLobby` snapshots (T27); created before the core loads so it can be
    // appended on top of the canvas.
    const lobbyHost: UiElement | null =
      route.kind === "play" && route.room && netplay
        ? deps.env.doc.createElement("div")
        : null;
    if (lobbyHost) lobbyHost.className = "lobby-host";
    // Live scoreboard overlay for the player (T32), next to the lobby.
    const scoreboardHost: UiElement | null = lobbyHost
      ? deps.env.doc.createElement("div")
      : null;
    if (scoreboardHost) scoreboardHost.className = "scoreboard-host";

    setStatus(`loading ${entry.title}...`);
    void deps
      .loadCore(entry, { netplay: Boolean(route.room), canvas: deps.env.screen })
      .then((core) => {
        if (myToken !== token) {
          core.destroy();
          return;
        }
        if (route.kind === "watch" && netplay) {
          startViewer(core, entry, route.room, netplay);
          return;
        }
        if (route.room && netplay && lobbyHost) {
          const host = lobbyHost;
          const room = route.room;
          // Dev-only metrics overlay (T28), over the canvas next to the lobby.
          const overlayHost =
            deps.env.devOverlay === true ? deps.env.doc.createElement("div") : null;
          if (overlayHost) overlayHost.className = "netplay-overlay-host";
          const renderLobby = (state: LobbyState): void => {
            host.textContent = "";
            host.append(
              renderTree(
                deps.env.doc,
                buildLobby(state, {
                  onWatch: () =>
                    deps.env.navigate(watchHref(entry.driver, room)),
                  onStart: () => {
                    if (match?.start()) return;
                    setStatus(
                      match?.isHost()
                        ? "waiting for players..."
                        : "only the host can start the game",
                    );
                  },
                  onSetReady: (ready) => {
                    match?.setReady(ready);
                  },
                  onToggleVideo: (enabled) => {
                    match?.setVideo(enabled);
                  },
                  onLeave: () => deps.env.navigate("#/"),
                }),
              ),
            );
          };
          // Host-side A/V publisher (T41): publishes the shared canvas + tapped
          // MAME audio when the relay hands this host LiveKit credentials.
          const publisher =
            deps.env.screen && deps.env.liveKit
              ? createVideoPublisher({
                  factory: deps.env.liveKit,
                  canvas: deps.env.screen,
                  getAudioStream: deps.env.getAudioStream ?? (() => null),
                  log: (event, fields) => console.warn("[netplay]", event, fields),
                })
              : undefined;
          match = createMatch({
            core,
            ...rollbackConfig(entry, deps.env),
            config: {
              relayUrl: netplay.relayUrl,
              token: netplay.token,
              room,
              role: "player",
              iceServers: netplay.iceServers,
            },
            // The host announces this so the relay can fill room.state and open
            // an input log (T30); DIPs default until a DIP UI exists.
            game: {
              driver: entry.driver,
              coreHash: entry.coreVersion,
              mameCommit: entry.mameCommit,
              romHash: entry.romHash,
              dips: {},
            },
            socketFactory: netplay.socketFactory,
            factory: netplay.factory,
            now: netplay.now ?? (() => Date.now()),
            onStatus: (status) => setStatus(matchStatusText(status)),
            onLobby: renderLobby,
            // Live per-slot scores (T32); names come from the lobby roster.
            ...(scoreboardHost
              ? {
                  onScores: (rows: readonly { slot: number; score: number }[]) =>
                    renderScores(
                      scoreboardHost,
                      rows,
                      new Map(
                        (match?.lobby().players ?? []).map((player) => [
                          player.slot,
                          player.name,
                        ]),
                      ),
                    ),
                }
              : {}),
            log: (event, fields) => console.warn("[netplay]", event, fields),
            ...(publisher ? { video: publisher } : {}),
            ...(deps.env.inputScript ? { inputScript: deps.env.inputScript } : {}),
            ...(overlayHost
              ? {
                  onMetrics: (snapshot) => {
                    overlayHost.textContent = "";
                    overlayHost.append(
                      renderTree(
                        deps.env.doc,
                        buildNetplayOverlay({
                          frame: snapshot.frame,
                          framesSent: snapshot.framesSent,
                          status: matchStatusText(match?.status() ?? "running"),
                          peers: snapshot.peers,
                        }),
                      ),
                    );
                  },
                }
              : {}),
          });
          renderLobby(match.lobby());
          // Collaborative pause on tab visibility (T29): hiding/occluding the
          // tab tells the relay to pause the room, so peers are not left
          // waiting on a throttled requestAnimationFrame.
          if (deps.env.visibility) {
            const visibility = deps.env.visibility;
            detachVisibility = visibility.onChange(() => {
              match?.setPaused(visibility.hidden());
            });
          }
          deps.env.root.append(host);
          if (overlayHost) deps.env.root.append(overlayHost);
          if (scoreboardHost) deps.env.root.append(scoreboardHost);
        }
        play = createPlayController({
          core,
          entry,
          document: deps.env.doc,
          scheduler: deps.env.scheduler,
          keyboard: deps.env.keyboard,
          gamepads: deps.env.gamepads,
          onStatus: setStatus,
          ...(inputSetup ? { inputConfig: () => inputSetup.config() } : {}),
          ...(match ? { lockstep: match } : {}),
          ...(screenUi ? { screen: screenUi } : {}),
        });
        if (!screenUi) deps.env.root.append(play.screen);
        // DEV-only: expose the sampled per-slot mask so a stuck control (e.g. a
        // gamepad the browser is not delivering) can be diagnosed from the
        // console: `__WMA_INPUTS__()` while pressing a button.
        if (deps.env.devOverlay === true) {
          const controller = play;
          (
            globalThis as unknown as { __WMA_INPUTS__?: () => readonly number[] }
          ).__WMA_INPUTS__ = () => controller.inputs();
          // DEV HUD: live per-slot mask + raw gamepad state, so a control that
          // is not reaching the app can be seen in-game without DevTools.
          const hud = deps.env.doc.createElement("div");
          hud.className = "input-hud";
          deps.env.root.append(hud);
          inputHudTimer = setInterval(() => {
            const pads =
              (
                globalThis as unknown as {
                  navigator?: { getGamepads?: () => (Gamepad | null)[] };
                }
              ).navigator?.getGamepads?.() ?? [];
            const padText = Array.from(pads)
              .filter((p): p is Gamepad => p !== null)
              .map((p) => {
                const buttons = Array.from(p.buttons)
                  .map((b, i) => (b.pressed ? i : -1))
                  .filter((i) => i >= 0);
                const axes = Array.from(p.axes).map((v) => Number(v).toFixed(2));
                return `#${p.index} map=${p.mapping || "-"} btn=[${buttons.join(",")}] ax=[${axes.join(",")}]`;
              })
              .join(" ");
            hud.textContent = `P1..4=${controller.inputs().join(",")} ${padText}`;
          }, 100);
        }
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
  /** Overrides the replay-log fetch; by default `GET /api/replays/<key>`. */
  loadReplay?: (key: string) => Promise<Uint8Array>;
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

type CoreLoader = (entry: GameEntry, options: LoadCoreOptions) => Promise<Core>;

/**
 * DEV-only: expose the booted core on `window.__WMA_CORE__` for the T28 spike
 * harness (e2e/spike.e2e.ts). Gated like the T26 input hook so a production
 * bundle cannot be armed from a page; it hands out the same core the page would
 * already run, and never changes the emulation path.
 */
function exposeCoreForSpike(win: Window, loadCore: CoreLoader): CoreLoader {
  return async (entry, options) => {
    const core = await loadCore(entry, options);
    (win as unknown as { __WMA_CORE__?: Core }).__WMA_CORE__ = core;
    return core;
  };
}

/**
 * Attach the viewer's remote A/V stream to a lazily-created `<video>` overlay
 * (T41); detaches/hides on null. Set only by `startApp`.
 */
function createVideoAttacher(container: HTMLElement, doc: Document) {
  let el: HTMLVideoElement | null = null;
  return (stream: MediaStream | null): void => {
    if (stream) {
      if (!el) {
        el = doc.createElement("video");
        el.className = "viewer-video-el";
        el.autoplay = true;
        // The viewer may be running the same core (input replay), which already
        // plays MAME audio; mute the video track to avoid doubling it.
        el.muted = true;
        el.playsInline = true;
        container.append(el);
      }
      el.srcObject = stream;
      el.style.display = "block";
    } else if (el) {
      el.srcObject = null;
      el.style.display = "none";
    }
  };
}

/** Default core loader: fixed args, ROM mounted under `-rompath`. */
function browserCoreLoader(entry: GameEntry, options: LoadCoreOptions): Promise<Core> {
  const romPath = "/roms";
  const sessionPath = "/session";
  return loadBrowserCore({
    coreBaseUrl: coreDirUrl(entry),
    romZipUrl: entry.romZipUrl,
    ...(entry.extraRomZips ? { extraRomZips: entry.extraRomZips } : {}),
    driver: entry.driver,
    args: buildMameArgs({ driver: entry.driver, romPath, sessionPath }),
    romPath,
    romZipName: `${entry.driver}.zip`,
    // Live-score addresses/format for this driver (T32b); 404 = none.
    scoreMapUrl: `/static/scoremap/${entry.driver}.json`,
    netplay: options.netplay,
    ...(options.canvas ? { canvas: options.canvas } : {}),
  });
}

/**
 * Default replay-log fetch (T35): read the gzip artifact from the API's replay
 * route (T34), `VITE_API_URL` or `/api/replays`. The gunzip/decode happens in
 * the replay route so this stays a plain fetch.
 */
function browserReplayLoader(): (key: string) => Promise<Uint8Array> {
  const env =
    (import.meta as unknown as { env?: Record<string, string | boolean> }).env ?? {};
  const base =
    typeof env.VITE_API_URL === "string" && env.VITE_API_URL.length > 0
      ? env.VITE_API_URL
      : "/api/replays";
  return async (key: string): Promise<Uint8Array> => {
    const response = await fetch(`${base}/${encodeURIComponent(key)}`);
    if (!response.ok) {
      throw new Error(`replay fetch failed: ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}

interface ResumableAudioContext {
  resume(): Promise<void>;
}

type AudioContextCtor = new (...args: unknown[]) => ResumableAudioContext;

/**
 * Browsers start AudioContexts suspended until a user gesture. MAME creates its
 * context during boot (before any click), so capture every context via a Proxy
 * around the constructor and resume them all on the first pointer/key gesture.
 */
export function installAudioUnlock(win: Window): void {
  const target = win as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  const contexts = new Set<ResumableAudioContext>();
  let unlocked = false;

  const wrap = (Ctor: AudioContextCtor | undefined): AudioContextCtor | undefined => {
    if (!Ctor) return undefined;
    return new Proxy(Ctor, {
      construct(constructor, args, newTarget) {
        const ctx = Reflect.construct(constructor, args, newTarget) as ResumableAudioContext;
        contexts.add(ctx);
        if (unlocked) void ctx.resume();
        return ctx;
      },
    });
  };

  const Wrapped = wrap(target.AudioContext);
  const WrappedWebkit = wrap(target.webkitAudioContext);
  if (Wrapped) target.AudioContext = Wrapped;
  if (WrappedWebkit) target.webkitAudioContext = WrappedWebkit;

  const unlock = (): void => {
    unlocked = true;
    for (const ctx of contexts) void ctx.resume();
    win.removeEventListener("pointerdown", unlock);
    win.removeEventListener("keydown", unlock);
  };
  win.addEventListener("pointerdown", unlock);
  win.addEventListener("keydown", unlock);
}

/** localStorage if it is usable (private mode / disabled storage throws). */
function safeStorage(win: Window): StorageLike | undefined {
  try {
    const storage = win.localStorage;
    const probe = "__wma_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return undefined;
  }
}

/** Wire the app to real browser globals and the static catalogue. */
export async function startApp(options: StartOptions = {}): Promise<AppController> {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  installAudioUnlock(win);
  // Tap MAME's audio into a MediaStream the host can publish (T41); a no-op
  // when the Web Audio APIs are missing.
  const capture = installAudioCapture(win as unknown as AudioCaptureEnv);
  const loadGames = options.loadGames ?? loadCatalogue;
  // e2e hooks (T26/T28) are dev-only: a production bundle must not be armable
  // from a page (a scripted input macro the verifier would replay cleanly, or a
  // page reaching into the core).
  const devEnv = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  const baseLoadCore = options.loadCore ?? browserCoreLoader;
  const loadCore =
    devEnv?.DEV === true ? exposeCoreForSpike(win, baseLoadCore) : baseLoadCore;

  const games = await loadGames(options.catalogueUrl ?? "/games.json");

  const appEl = doc.getElementById("app");
  if (!appEl) throw new Error("startApp: missing #app element");
  const rootEl = doc.createElement("div");
  const statusEl = doc.createElement("p");
  statusEl.className = "status";
  appEl.append(rootEl, statusEl);

  const netplay = options.netplay ?? netplayFromEnv();
  // e2e input hook (T26): dev-only (see the hooks note above).
  const inputScript = devEnv?.DEV ? readInputScript(win) : undefined;
  const forceRollback =
    devEnv?.DEV === true &&
    (win as { __WMA_TEST_ROLLBACK__?: unknown }).__WMA_TEST_ROLLBACK__ === true;

  // Per-session input wiring (T12): persisted device/button overrides + gamepad
  // hot-plug. Attached here so assignment survives route changes.
  const storage = safeStorage(win);
  const inputSetup = createInputSetup({
    ...(storage ? { storage } : {}),
    gamepads: win.navigator,
    events: win as unknown as GamepadEventTarget,
    keyboard: win,
  });
  const detachGamepads = inputSetup.attach();

  // SDL3's emscripten video backend resolves its canvas by the CSS selector
  // `#canvas` (`document.querySelector`); MAME's WebGL context creation fails
  // without it, so the shared render canvas carries that id.
  const screenEl = doc.createElement("canvas");
  screenEl.id = "canvas";

  const liveKit = liveKitFactoryFromEnv();

  const controller = createApp({
    games,
    loadCore,
    loadReplay: options.loadReplay ?? browserReplayLoader(),
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
      inputSetup,
      visibility: {
        hidden: () => doc.hidden,
        onChange: (listener) => {
          doc.addEventListener("visibilitychange", listener);
          return () => doc.removeEventListener("visibilitychange", listener);
        },
      },
      screen: screenEl,
      liveKit,
      getAudioStream: () => capture.getAudioStream(),
      attachVideo: createVideoAttacher(appEl, doc),
      ...(netplay ? { netplay } : {}),
      ...(inputScript ? { inputScript } : {}),
      ...(forceRollback ? { forceRollback: true } : {}),
      ...(devEnv?.DEV === true ? { devOverlay: true } : {}),
    },
  });
  return {
    destroy: () => {
      detachGamepads();
      controller.destroy();
    },
  };
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
