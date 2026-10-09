import { describe, expect, it, vi } from "vitest";
import { PLAYER_SLOTS } from "@wma/protocol";
import type { Core } from "../core/types";
import type { GameEntry } from "../catalogue";
import type { GamepadsProvider } from "../input/gamepad";
import type { KeyboardTarget } from "../input/keyboard";
import type { UiDocument, UiElement } from "../ui/view";
import {
  createApp,
  coreDirUrl,
  netplayFromEnv,
  type AppEnv,
  type NetplayEnv,
} from "./app";
import {
  FakeWebSocket,
  fakeRtcFactory,
  fakeSocketFactory,
} from "../netplay/test-fakes";

const entry: GameEntry = {
  driver: "gridlee",
  title: "Gridlee",
  coreVersion: "a".repeat(64),
  mameCommit: "b".repeat(40),
  supportsSave: true,
  netplayMode: "lockstep",
  maxPlayers: 2,
  romLicensed: true,
  coreBaseUrl: "/static/cores/gridlee",
  romZipUrl: "/roms/gridlee.zip",
};

interface FakeElement extends UiElement {
  children: FakeElement[];
}

function makeElement(): FakeElement {
  let text: string | null = null;
  const el = {
    className: "",
    children: [] as FakeElement[],
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
    addEventListener() {},
  } as FakeElement;
  return el;
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
  const env: AppEnv = {
    doc,
    root,
    status,
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
    listenerCount: () => listeners.size,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

  it("warns when an online route has no relay configuration", async () => {
    const h = harness();
    const app = createApp({ env: h.env, games: [entry], loadCore: h.loadCore });

    h.hash.value = "#/game/gridlee/room/abc";
    h.fire();
    await flush();

    expect(h.status.textContent).toContain("not configured");
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

describe("netplayFromEnv", () => {
  it("returns undefined when no relay env is configured", () => {
    expect(netplayFromEnv()).toBeUndefined();
  });
});

describe("coreDirUrl", () => {
  it("appends the content-addressed core hash to the driver base URL", () => {
    expect(coreDirUrl(entry)).toBe(`/static/cores/gridlee/${entry.coreVersion}`);
  });
});
