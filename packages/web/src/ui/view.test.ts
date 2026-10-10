import { describe, expect, it, vi } from "vitest";
import {
  browserUiDocument,
  renderTree,
  type UiDocument,
  type UiElement,
  type UiEvent,
  type ViewNode,
} from "./view";

interface FakeElement extends UiElement {
  children: FakeElement[];
  parent?: FakeElement;
  listeners: ((event: UiEvent) => void)[];
}

function makeElement(tag: string): FakeElement {
  const el: FakeElement = {
    className: "",
    textContent: null,
    children: [],
    listeners: [],
    append(child: UiElement): void {
      const fake = child as FakeElement;
      fake.parent = el;
      el.children.push(fake);
    },
    addEventListener(_type, listener): void {
      el.listeners.push(listener);
    },
  };
  (el as FakeElement & { tag: string }).tag = tag;
  return el;
}

function fakeDoc(): UiDocument & { created: FakeElement[] } {
  const created: FakeElement[] = [];
  return {
    created,
    createElement(tag: string): UiElement {
      const el = makeElement(tag);
      created.push(el);
      return el;
    },
  };
}

describe("renderTree", () => {
  it("sets tag, class, text and nested children", () => {
    const doc = fakeDoc();
    const node: ViewNode = {
      tag: "section",
      className: "game",
      children: [{ tag: "h2", text: "Gridlee" }],
    };
    const el = renderTree(doc, node) as FakeElement;
    expect(el.className).toBe("game");
    expect(el.children).toHaveLength(1);
    expect(el.children[0]?.textContent).toBe("Gridlee");
  });

  it("wires onClick to a click listener that prevents default", () => {
    const doc = fakeDoc();
    const onClick = vi.fn();
    const el = renderTree(doc, { tag: "button", text: "play", onClick }) as FakeElement;
    const event: UiEvent = { preventDefault: vi.fn() };
    el.listeners[0]?.(event);
    expect(onClick).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("propagates the disabled flag onto the element", () => {
    const doc = fakeDoc();
    const el = renderTree(doc, {
      tag: "button",
      text: "start",
      disabled: true,
    }) as FakeElement;
    expect(el.disabled).toBe(true);
  });
});

describe("browserUiDocument", () => {
  it("wraps real elements and unwraps them on append", () => {
    const root = {
      createElement: (tag: string) => makeElement(tag) as unknown as Element,
    } as unknown as Document;

    const doc = browserUiDocument(root);
    const parent = doc.createElement("div") as unknown as FakeElement & { el: FakeElement };
    const child = doc.createElement("span") as unknown as FakeElement & { el: FakeElement };
    child.className = "x";
    parent.append(child);
    expect(parent.className).toBe("");
    expect(child.className).toBe("x");
    // The wrapper unwrapped the child to its underlying element.
    expect(parent.el.children).toEqual([child.el]);
  });
});
