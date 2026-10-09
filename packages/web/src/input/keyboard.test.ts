import { describe, expect, it, vi } from "vitest";
import { BUTTON_BITS } from "@wma/protocol";
import { DEFAULT_KEYBOARD_BINDINGS, playerBindings } from "./bindings";
import {
  attachKeyboard,
  createKeyState,
  playerMaskFromKeys,
  type KeyboardTarget,
} from "./keyboard";

function fakeTarget(): KeyboardTarget & {
  dispatch: (type: "keydown" | "keyup", code: string) => boolean;
} {
  const listeners = new Map<string, Set<(event: KeyboardEvent) => void>>();
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, code) {
      const event = {
        code,
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent;
      for (const listener of listeners.get(type) ?? []) listener(event);
      return (event.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length > 0;
    },
  };
}

describe("createKeyState", () => {
  it("tracks pressed keys and clears on release", () => {
    const state = createKeyState();
    state.press("KeyZ");
    expect(state.pressed().has("KeyZ")).toBe(true);
    state.release("KeyZ");
    expect(state.pressed().has("KeyZ")).toBe(false);
  });
});

describe("playerMaskFromKeys", () => {
  const bindings = playerBindings({
    b1: [{ kind: "key", code: "KeyZ" }],
    up: [{ kind: "key", code: "ArrowUp" }],
  });

  it("sets the bit for a pressed bound key", () => {
    expect(playerMaskFromKeys(bindings, new Set(["KeyZ"]))).toBe(BUTTON_BITS.b1);
  });

  it("ORs multiple pressed buttons together", () => {
    expect(playerMaskFromKeys(bindings, new Set(["KeyZ", "ArrowUp"]))).toBe(
      BUTTON_BITS.b1 | BUTTON_BITS.up,
    );
  });

  it("ignores unbound keys", () => {
    expect(playerMaskFromKeys(bindings, new Set(["KeyQ"]))).toBe(0);
  });

  it("clears the bit once the key is released", () => {
    const state = createKeyState();
    state.press("KeyZ");
    expect(playerMaskFromKeys(bindings, state.pressed())).toBe(BUTTON_BITS.b1);
    state.release("KeyZ");
    expect(playerMaskFromKeys(bindings, state.pressed())).toBe(0);
  });

  it("does not read gamepad bindings from the keyboard", () => {
    expect(
      playerMaskFromKeys(DEFAULT_KEYBOARD_BINDINGS, new Set(["KeyZ"])),
    ).toBe(BUTTON_BITS.b1);
  });
});

describe("attachKeyboard", () => {
  it("presses on keydown and releases on keyup", () => {
    const target = fakeTarget();
    const state = createKeyState();
    attachKeyboard(target, state);
    target.dispatch("keydown", "KeyZ");
    expect(state.pressed().has("KeyZ")).toBe(true);
    target.dispatch("keyup", "KeyZ");
    expect(state.pressed().has("KeyZ")).toBe(false);
  });

  it("prevents default only for configured game keys", () => {
    const target = fakeTarget();
    const state = createKeyState();
    attachKeyboard(target, state, {
      preventDefaultFor: new Set(["ArrowUp"]),
    });
    expect(target.dispatch("keydown", "ArrowUp")).toBe(true);
    expect(target.dispatch("keydown", "KeyQ")).toBe(false);
  });

  it("detaches both listeners", () => {
    const target = fakeTarget();
    const state = createKeyState();
    const detach = attachKeyboard(target, state);
    detach();
    target.dispatch("keydown", "KeyZ");
    expect(state.pressed().has("KeyZ")).toBe(false);
  });
});
