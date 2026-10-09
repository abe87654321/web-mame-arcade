import { describe, expect, it, vi } from "vitest";
import {
  gameHref,
  parseRoute,
  startRouter,
  type RouterTarget,
} from "./router";

describe("parseRoute", () => {
  it("maps the root to the list", () => {
    expect(parseRoute("#/")).toEqual({ kind: "list" });
    expect(parseRoute("#")).toEqual({ kind: "list" });
    expect(parseRoute("")).toEqual({ kind: "list" });
  });

  it("maps a game hash to a play route", () => {
    expect(parseRoute("#/game/gridlee")).toEqual({
      kind: "play",
      driver: "gridlee",
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
  it("builds the play link for a driver", () => {
    expect(gameHref("gridlee")).toBe("#/game/gridlee");
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
    });

    stop();
    expect(t.listening).toBe(false);
    t.fire();
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
