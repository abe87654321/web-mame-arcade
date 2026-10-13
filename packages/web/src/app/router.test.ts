import { describe, expect, it, vi } from "vitest";
import {
  gameHref,
  parseRoute,
  replayHref,
  startRouter,
  watchHref,
  type RouterTarget,
} from "./router";

describe("parseRoute", () => {
  it("maps the root to the list", () => {
    expect(parseRoute("#/")).toEqual({ kind: "list" });
    expect(parseRoute("#")).toEqual({ kind: "list" });
    expect(parseRoute("")).toEqual({ kind: "list" });
  });

  it("maps a game hash to a solo play route", () => {
    expect(parseRoute("#/game/gridlee")).toEqual({
      kind: "play",
      driver: "gridlee",
      room: null,
    });
  });

  it("maps a game hash with a room to a netplay play route", () => {
    expect(parseRoute("#/game/gridlee/room/abc123")).toEqual({
      kind: "play",
      driver: "gridlee",
      room: "abc123",
    });
  });

  it("maps a watch hash to the viewer route", () => {
    expect(parseRoute("#/game/gridlee/room/abc123/watch")).toEqual({
      kind: "watch",
      driver: "gridlee",
      room: "abc123",
    });
  });

  it("rejects a watch hash without a room", () => {
    expect(parseRoute("#/game/gridlee/watch")).toEqual({
      kind: "not-found",
      path: "/game/gridlee/watch",
    });
  });

  it("maps a replay hash to the replay route, decoding the key", () => {
    expect(parseRoute("#/game/gridlee/replay/match%2Froom1%2Flog.json.gz")).toEqual({
      kind: "replay",
      driver: "gridlee",
      key: "match/room1/log.json.gz",
    });
  });

  it("rejects a replay hash without a key", () => {
    expect(parseRoute("#/game/gridlee/replay/")).toEqual({
      kind: "not-found",
      path: "/game/gridlee/replay/",
    });
  });

  it("rejects a missing driver", () => {
    expect(parseRoute("#/game/")).toEqual({
      kind: "not-found",
      path: "/game/",
    });
  });

  it("maps an unknown hash to not-found", () => {
    expect(parseRoute("#/nope")).toEqual({
      kind: "not-found",
      path: "/nope",
    });
  });
});

describe("gameHref", () => {
  it("builds the solo play link for a driver", () => {
    expect(gameHref("gridlee")).toBe("#/game/gridlee");
  });

  it("builds the netplay play link with a room", () => {
    expect(gameHref("gridlee", "abc123")).toBe("#/game/gridlee/room/abc123");
  });
});

describe("watchHref", () => {
  it("builds the viewer link for a driver and room", () => {
    expect(watchHref("gridlee", "abc123")).toBe(
      "#/game/gridlee/room/abc123/watch",
    );
  });
});

describe("replayHref", () => {
  it("builds the replay link, encoding the key", () => {
    expect(replayHref("gridlee", "match/room1/log.json.gz")).toBe(
      "#/game/gridlee/replay/match%2Froom1%2Flog.json.gz",
    );
  });
});

describe("startRouter", () => {
  function target(): RouterTarget & { fire(): void; listening: boolean } {
    const listeners = new Set<() => void>();
    return {
      listening: false,
      addEventListener(_type, listener) {
        listeners.add(listener);
        this.listening = true;
      },
      removeEventListener(_type, listener) {
        listeners.delete(listener);
        this.listening = false;
      },
      fire() {
        for (const listener of listeners) listener();
      },
    };
  }

  it("emits the current route on start and on hashchange", () => {
    let hash = "#/";
    const t = target();
    const onChange = vi.fn();
    const stop = startRouter(t, () => hash, onChange);
    expect(onChange).toHaveBeenLastCalledWith({ kind: "list" });

    hash = "#/game/gridlee";
    t.fire();
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "play",
      driver: "gridlee",
      room: null,
    });

    stop();
    expect(t.listening).toBe(false);
    t.fire();
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
