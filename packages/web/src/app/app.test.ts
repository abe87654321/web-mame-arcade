import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAYER_SLOTS } from "@wma/protocol";
import type { Core } from "../core/types";
import type { GameEntry } from "../catalogue";
import type { GamepadsProvider } from "../input/gamepad";
import type { KeyboardTarget } from "../input/keyboard";
import type { UiDocument, UiElement } from "../ui/view";
import {
  createApp,
  coreDirUrl,
  installAudioUnlock,
  matchStatusText,
  netplayFromEnv,
  rollbackConfig,
  type AppEnv,
  type NetplayEnv,
} from "./app";
import {
  FakePeerConnection,
  FakeWebSocket,
  fakeRtcFactory,
  fakeSocketFactory,
} from "../netplay/test-fakes";

const entry: GameEntry = {
  driver: "gridlee",
  title: "Gridlee",
  coreVersion: "a".repeat(64),
  mameCommit: "b".repeat(40),
  romHash: "c".repeat(64),
  supportsSave: true,
  netplayMode: "lockstep",
  maxPlayers: 2,
  romLicensed: true,
  coreBaseUrl: "/static/cores/gridlee",
  romZipUrl: "/roms/gridlee.zip",
};

interface FakeElement extends UiElement {
  children: FakeElement[];
  disabled?: boolean;
  listeners: ((event: { preventDefault(): void }) => void)[];
  click(): void;
}

function makeElement(): FakeElement {
  let text: string | null = null;
  const el = {
    className: "",
    children: [] as FakeElement[],
    listeners: [] as ((event: { preventDefault(): void }) => void)[],
    disabled: false,
    get textContent() {
      return text;
    },
    set textContent(value: string | null) {
      text = value;
      if (value !== null) el.children.length = 0;
    },
    append(child: UiElement) {
      el.children.push(child as FakeElement);
    },
    addEventListener(_type: "click", listener: (event: { preventDefault(): void }) => void) {
      el.listeners.push(listener);
    },
    click() {
      for (const listener of el.listeners) listener({ preventDefault() {} });
    },
  } as FakeElement;
  return el;
}

function findByClass(root: FakeElement, className: string): FakeElement | undefined {
  if (root.className.split(" ").includes(className)) return root;
  for (const child of root.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return undefined;
}

function fakeDoc(): UiDocument {
  return { createElement: () => makeElement() };
}

function fakeCore(): Core {
  return {
    load: vi.fn(async () => {}),
    step: vi.fn(),
    save: vi.fn(),
    loadState: vi.fn(),
    hash: vi.fn(),
    readScore: vi.fn(),
    reset: vi.fn(),
    destroy: vi.fn(),
  } as unknown as Core;
}

interface Harness {
  env: AppEnv;
  root: FakeElement;
  status: FakeElement;
  hash: { value: string };
  fire(): void;
  setHidden(hidden: boolean): void;
  listenerCount(): number;
  loadCore: ReturnType<typeof vi.fn>;
  cores: Core[];
}

function harness(netplay?: NetplayEnv): Harness {
  const doc = fakeDoc();
  const root = makeElement();
  const status = makeElement();
  const hash = { value: "#/" };
  const listeners = new Set<() => void>();
  const cores: Core[] = [];
  const loadCore = vi.fn(async () => {
    const core = fakeCore();
    cores.push(core);
    return core;
  });
  const gamepads: GamepadsProvider = {
    getGamepads: () => Array.from({ length: PLAYER_SLOTS }, () => null),
  };
  const keyboard = {
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as KeyboardTarget;
  const visibilityListeners = new Set<() => void>();
  const visibilityState = { hidden: false };
  const env: AppEnv = {
    doc,
    root,
    status,
    visibility: {
      hidden: () => visibilityState.hidden,
      onChange: (listener) => {
        visibilityListeners.add(listener);
        return () => visibilityListeners.delete(listener);
      },
    },
    target: {
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
    },
    getHash: () => hash.value,
    navigate: (href) => {
      hash.value = href;
      for (const listener of [...listeners]) listener();
    },
    scheduler: { request: () => 1, cancel: () => {} },
    keyboard,
    gamepads,
    ...(netplay ? { netplay } : {}),
  };
  return {
    env,
    root,
    status,
    hash,
    loadCore,
    cores,
    fire: () => {
      for (const listener of [...listeners]) listener();
    },
    setHidden: (hidden: boolean) => {
      visibilityState.hidden = hidden;
      for (const listener of [...visibilityListeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

/** gzip bytes for a replay-log artifact the app will gunzip + decode. */
async function gzipBytes(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A minimal closed log matching `entry`'s core/ROM/commit identity. */
function replayLog(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    room: "room1",
    meta: {
      driver: "gridlee",
      core_hash: entry.coreVersion,
      mame_commit: entry.mameCommit,
      rom_hash: entry.romHash,
      dips: {},
      mode: "solo",
    },
    start: {
      frame: 0,
      input_delay: 1,
      players: [{ slot: 0, name: "alice" }],
      start_state_key: null,
    },
    end: { frame: 2, scores: [{ slot: 0, score: 0 }] },
    frames: [[0], [0x10], [0]],
    ...overrides,
  });
}

describe("createApp", () => {
  it("renders the catalogue on start", () => {
    const h = harness();
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });
    expect(h.root.children).toHaveLength(1);
    expect(h.root.children[0]?.className).toBe("catalogue");
    app.destroy();
  });

  it("loads the core and mounts the screen on a play route", async () => {
    const h = harness();
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee";
    h.fire();
    await flush();

    expect(h.loadCore).toHaveBeenCalledWith(entry, { netplay: false });
    expect(h.root.children).toHaveLength(1);
    expect(h.root.children[0]?.className).toBe("screen");
    expect(h.status.textContent).toContain("Gridlee");
    app.destroy();
  });

  it("destroys the core when navigating away from play", async () => {
    const h = harness();
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee";
    h.fire();
    await flush();
    expect(h.cores).toHaveLength(1);

    h.hash.value = "#/";
    h.fire();
    expect(h.cores[0]?.destroy).toHaveBeenCalledOnce();
    app.destroy();
  });

  it("clears the status line when leaving a game", async () => {
    const h = harness();
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee";
    h.fire();
    await flush();
    expect(h.status.textContent).toContain("Gridlee");

    h.hash.value = "#/";
    h.fire();
    expect(h.status.textContent).toBe("");
    app.destroy();
  });

  it("shows a not-found message for an unknown driver", async () => {
    const h = harness();
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/pacman";
    h.fire();
    await flush();

    expect(h.loadCore).not.toHaveBeenCalled();
    expect(h.root.children[0]?.textContent).toContain("Unknown game");
    app.destroy();
  });

  it("joins the named room when a netplay route is configured", async () => {
    const socket = new FakeWebSocket();
    const h = harness({
      relayUrl: "ws://relay.test/ws",
      token: "jwt",
      iceServers: [],
      socketFactory: fakeSocketFactory(socket),
      factory: fakeRtcFactory([]),
    });
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee/room/abc";
    h.fire();
    await flush();
    socket.open();

    expect(h.loadCore).toHaveBeenCalledWith(entry, { netplay: true });
    expect(socket.sent).toContain(
      JSON.stringify({ t: "room.join", room: "abc", role: "player", token: "jwt" }),
    );
    app.destroy();
    expect(socket.closes).toBe(1);
  });

  it("boots a frozen core and joins as a viewer on a watch route (T31)", async () => {
    const socket = new FakeWebSocket();
    const h = harness({
      relayUrl: "ws://relay.test/ws",
      token: "jwt",
      iceServers: [],
      socketFactory: fakeSocketFactory(socket),
      factory: fakeRtcFactory([]),
    });
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee/room/abc/watch";
    h.fire();
    await flush();
    socket.open();
    await flush();

    expect(h.loadCore).toHaveBeenCalledWith(entry, { netplay: true });
    expect(socket.sent).toContain(
      JSON.stringify({ t: "room.join", room: "abc", role: "viewer", token: "jwt" }),
    );
    expect(findByClass(h.root, "viewer")).toBeDefined();
    app.destroy();
    expect(socket.closes).toBe(1);
  });

  it("navigates to the watch link from the lobby (T31)", async () => {
    const socket = new FakeWebSocket();
    const pc = new FakePeerConnection();
    const h = harness({
      relayUrl: "ws://relay.test/ws",
      token: "jwt",
      iceServers: [],
      socketFactory: fakeSocketFactory(socket),
      factory: fakeRtcFactory([pc]),
    });
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee/room/abc";
    h.fire();
    await flush();
    socket.open();
    await flush();
    socket.emitMessage(
      JSON.stringify({
        t: "room.state",
        room: "abc",
        self: 0,
        players: [{ slot: 0, name: "You", ready: false }],
        game: null,
        coreHash: null,
        romHash: null,
        dips: {},
        status: "waiting",
      }),
    );
    await flush();

    findByClass(h.root, "watch")?.click();
    expect(h.hash.value).toBe("#/game/gridlee/room/abc/watch");
    app.destroy();
  });

  it("warns when an online route has no relay configuration", async () => {
    const h = harness();
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee/room/abc";
    h.fire();
    await flush();

    expect(h.status.textContent).toContain("not configured");
    app.destroy();
  });

  it("renders the lobby from room.state and starts the game on the host button", async () => {
    const socket = new FakeWebSocket();
    const pc = new FakePeerConnection();
    const h = harness({
      relayUrl: "ws://relay.test/ws",
      token: "jwt",
      iceServers: [],
      socketFactory: fakeSocketFactory(socket),
      factory: fakeRtcFactory([pc]),
    });
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee/room/abc";
    h.fire();
    await flush();
    socket.open();
    await flush();
    socket.emitMessage(
      JSON.stringify({
        t: "room.state",
        room: "abc",
        self: 0,
        players: [
          { slot: 0, name: "You", ready: false },
          { slot: 1, name: "Ryu", ready: true },
        ],
        game: null,
        coreHash: null,
        romHash: null,
        dips: {},
        status: "waiting",
      }),
    );
    await flush();

    expect(findByClass(h.root, "lobby")).toBeDefined();
    expect(findByClass(h.root, "lobby-slot")).toBeDefined();
    const start = findByClass(h.root, "start-game");
    expect(start?.disabled).toBe(false);

    start?.click();
    expect(socket.sent).toContain(
      JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 2 }),
    );
    app.destroy();
  });

  it("returns to the catalogue when the lobby Leave button is clicked", async () => {
    const socket = new FakeWebSocket();
    const pc = new FakePeerConnection();
    const h = harness({
      relayUrl: "ws://relay.test/ws",
      token: "jwt",
      iceServers: [],
      socketFactory: fakeSocketFactory(socket),
      factory: fakeRtcFactory([pc]),
    });
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee/room/abc";
    h.fire();
    await flush();
    socket.open();
    await flush();
    socket.emitMessage(
      JSON.stringify({
        t: "room.state",
        room: "abc",
        self: 0,
        players: [{ slot: 0, name: "You", ready: false }],
        game: null,
        coreHash: null,
        romHash: null,
        dips: {},
        status: "waiting",
      }),
    );
    await flush();

    findByClass(h.root, "leave")?.click();

    expect(h.hash.value).toBe("#/");
    expect(h.root.children[0]?.className).toBe("catalogue");
    app.destroy();
  });

  it("pauses the match when the tab hides and resumes on show (T29)", async () => {
    const socket = new FakeWebSocket();
    const pc = new FakePeerConnection();
    const h = harness({
      relayUrl: "ws://relay.test/ws",
      token: "jwt",
      iceServers: [],
      socketFactory: fakeSocketFactory(socket),
      factory: fakeRtcFactory([pc]),
    });
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee/room/abc";
    h.fire();
    await flush();
    socket.open();
    await flush();
    socket.emitMessage(
      JSON.stringify({
        t: "room.state",
        room: "abc",
        self: 0,
        players: [{ slot: 0, name: "You", ready: false }],
        game: null,
        coreHash: null,
        romHash: null,
        dips: {},
        status: "waiting",
      }),
    );
    await flush();
    socket.emitMessage(JSON.stringify({ t: "game.start", startFrame: 0, inputDelay: 0 }));
    await flush();

    h.setHidden(true);
    expect(socket.sent).toContain(JSON.stringify({ t: "player.pause", paused: true }));

    h.setHidden(false);
    expect(socket.sent).toContain(JSON.stringify({ t: "player.pause", paused: false }));
    app.destroy();
  });

  it("detaches the router on destroy", () => {
    const h = harness();
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });
    expect(h.listenerCount()).toBe(1);
    app.destroy();
    expect(h.listenerCount()).toBe(0);
  });
});

describe("matchStatusText", () => {
  it("distinguishes a mid-match lockstep stall from the lobby wait", () => {
    expect(matchStatusText("waiting")).toBe("syncing...");
    expect(matchStatusText("waiting-for-peers")).toBe("waiting for players...");
    expect(matchStatusText("running")).toBe("playing online");
  });
});

describe("installAudioUnlock", () => {
  it("resumes contexts created before the first gesture", () => {
    const listeners = new Map<string, () => void>();
    const win = {
      addEventListener: (type: string, listener: () => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    } as unknown as Window;
    class FakeAudioContext {
      resume = vi.fn(async () => {});
    }
    (win as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;

    installAudioUnlock(win);
    const Ctor = (win as unknown as { AudioContext: new () => FakeAudioContext })
      .AudioContext;
    const ctx = new Ctor();

    expect(ctx.resume).not.toHaveBeenCalled();
    listeners.get("pointerdown")?.();
    expect(ctx.resume).toHaveBeenCalledOnce();
  });
});

describe("rollbackConfig (T40)", () => {
  it("enables rollback from the catalogue mode", () => {
    expect(
      rollbackConfig({ ...entry, netplayMode: "rollback", rollbackWindow: 4 }, {}),
    ).toEqual({ rollback: true, rollbackWindow: 4 });
  });

  it("does not enable rollback for lockstep games", () => {
    expect(rollbackConfig(entry, {})).toEqual({ rollback: false });
  });

  it("lets the dev/e2e hook force rollback", () => {
    expect(rollbackConfig(entry, { forceRollback: true })).toEqual({
      rollback: true,
    });
  });
});

describe("netplayFromEnv", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns undefined when no relay env is configured", () => {
    expect(netplayFromEnv()).toBeUndefined();
  });

  it("derives the LAN relay URL and dev token from the page", () => {
    vi.stubGlobal("location", {
      hostname: "192.168.3.110",
      search: "?token=dev-jwt",
    });

    const env = netplayFromEnv();

    expect(env?.relayUrl).toBe("ws://192.168.3.110:8787/ws");
    expect(env?.token).toBe("dev-jwt");
  });
});

describe("coreDirUrl", () => {
  it("appends the content-addressed core hash to the driver base URL", () => {
    expect(coreDirUrl(entry)).toBe(`/static/cores/gridlee/${entry.coreVersion}`);
  });
});

describe("live scoreboard overlay (T32)", () => {
  function text(el: FakeElement): string {
    return [el.textContent ?? "", ...el.children.map(text)].join(" ");
  }
  const netplay = () => {
    const socket = new FakeWebSocket();
    const pc = new FakePeerConnection();
    return {
      socket,
      env: {
        relayUrl: "ws://relay.test/ws",
        token: "jwt",
        iceServers: [],
        socketFactory: fakeSocketFactory(socket),
        factory: fakeRtcFactory([pc]),
      } as NetplayEnv,
    };
  };

  it("renders scores on a play route from a relayed score.live", async () => {
    const { socket, env } = netplay();
    const h = harness(env);
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee/room/abc";
    h.fire();
    await flush();
    socket.open();
    await flush();
    socket.emitMessage(
      JSON.stringify({
        t: "room.state",
        room: "abc",
        self: 0,
        players: [
          { slot: 0, name: "You", ready: false },
          { slot: 1, name: "Ryu", ready: true },
        ],
        game: "gridlee",
        coreHash: "a".repeat(64),
        romHash: "c".repeat(64),
        dips: {},
        status: "playing",
      }),
    );
    await flush();

    socket.emitMessage(
      JSON.stringify({ t: "score.live", player: 1, score: 77, frame: 60 }),
    );
    await flush();

    const board = findByClass(h.root, "scoreboard");
    expect(board).toBeDefined();
    expect(text(board!)).toContain("Ryu");
    expect(text(board!)).toContain("77");
    app.destroy();
  });

  it("renders scores on a watch route from a relayed score.live", async () => {
    const { socket, env } = netplay();
    const h = harness(env);
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee/room/abc/watch";
    h.fire();
    await flush();
    socket.open();
    await flush();
    socket.emitMessage(
      JSON.stringify({
        t: "viewer.state",
        room: "abc",
        driver: "gridlee",
        coreHash: "a".repeat(64),
        mameCommit: "b".repeat(40),
        romHash: "c".repeat(64),
        dips: {},
        startFrame: 0,
        inputDelay: 2,
        players: [
          { slot: 0, name: "You" },
          { slot: 1, name: "Ryu" },
        ],
        snapshot: null,
        video: false,
      }),
    );
    await flush();

    socket.emitMessage(
      JSON.stringify({ t: "score.live", player: 0, score: 123, frame: 60 }),
    );
    await flush();

    const board = findByClass(h.root, "scoreboard");
    expect(board).toBeDefined();
    expect(text(board!)).toContain("You");
    expect(text(board!)).toContain("123");
    app.destroy();
  });

  it("fetches, verifies and replays a closed log on a replay route (T35)", async () => {
    const h = harness();
    const bytes = await gzipBytes(replayLog());
    const loadReplay = vi.fn(async () => bytes);
    const app = createApp({
      env: h.env,
      games: [entry],
      loadCore: h.loadCore,
      loadReplay,
    });

    h.hash.value = "#/game/gridlee/replay/match%2Froom1%2Flog.json.gz";
    h.fire();
    await vi.waitFor(() => expect(text(h.root)).toContain("alice"));

    expect(findByClass(h.root, "replay")).toBeDefined();
    expect(loadReplay).toHaveBeenCalledWith("match/room1/log.json.gz");
    expect(h.loadCore).toHaveBeenCalledWith(entry, { netplay: true });

    app.destroy();
    expect(h.cores[0]?.destroy).toHaveBeenCalledOnce();
  });

  it.each(["core_hash", "rom_hash", "mame_commit"] as const)(
    "refuses a replay whose %s does not match the catalogue (T35)",
    async (field) => {
      const h = harness();
      const value = field === "mame_commit" ? "d".repeat(40) : "d".repeat(64);
      const bytes = await gzipBytes(
        replayLog({
          meta: {
            driver: "gridlee",
            core_hash: entry.coreVersion,
            mame_commit: entry.mameCommit,
            rom_hash: entry.romHash,
            dips: {},
            mode: "solo",
            [field]: value,
          },
        }),
      );
      const app = createApp({
        env: h.env,
        games: [entry],
        loadCore: h.loadCore,
        loadReplay: async () => bytes,
      });

      h.hash.value = "#/game/gridlee/replay/key";
      h.fire();
      await vi.waitFor(() =>
        expect(findByClass(h.root, "replay-error")).toBeDefined(),
      );

      expect(h.loadCore).not.toHaveBeenCalled();
      app.destroy();
    },
  );

  it("shows an error for a malformed replay artifact (T35)", async () => {
    const h = harness();
    const app = createApp({
      env: h.env,
      games: [entry],
      loadCore: h.loadCore,
      loadReplay: async () => new Uint8Array([1, 2, 3]),
    });

    h.hash.value = "#/game/gridlee/replay/key";
    h.fire();
    await vi.waitFor(() =>
      expect(findByClass(h.root, "replay-error")).toBeDefined(),
    );

    expect(h.loadCore).not.toHaveBeenCalled();
    app.destroy();
  });

  it("shows an error when replay loading is not configured (T35)", async () => {
    const h = harness();
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee/replay/key";
    h.fire();
    await flush();

    expect(findByClass(h.root, "replay-error")).toBeDefined();
    expect(h.loadCore).not.toHaveBeenCalled();
    app.destroy();
  });
});
