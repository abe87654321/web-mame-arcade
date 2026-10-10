/**
 * Framework-free view primitives (T13, extracted from the T12 remap UI). UI
 * logic builds a plain `ViewNode` tree and `renderTree` turns it into elements
 * through an injected `UiDocument`, so components stay DOM-free and unit-tested
 * with a fake document. `browserUiDocument` is the real-DOM adapter.
 */

export interface UiEvent {
  preventDefault(): void;
}

export interface UiElement {
  className: string;
  textContent: string | null;
  disabled?: boolean;
  append(child: UiElement): void;
  addEventListener(type: "click", listener: (event: UiEvent) => void): void;
}

export interface UiDocument {
  createElement(tag: string): UiElement;
}

export interface ViewNode {
  tag: string;
  className?: string;
  text?: string;
  disabled?: boolean;
  children?: ViewNode[];
  onClick?: () => void;
}

export function renderTree(doc: UiDocument, node: ViewNode): UiElement {
  const el = doc.createElement(node.tag);
  if (node.className) el.className = node.className;
  if (node.text !== undefined) el.textContent = node.text;
  if (node.disabled !== undefined) el.disabled = node.disabled;
  if (node.onClick) {
    const handler = node.onClick;
    el.addEventListener("click", (event) => {
      event.preventDefault();
      handler();
    });
  }
  for (const child of node.children ?? []) {
    el.append(renderTree(doc, child));
  }
  return el;
}

/**
 * Wrap an existing DOM element as a UiElement. Children passed to `append` are
 * unwrapped back to their Nodes; the UI code never sees the real DOM types.
 */
export function wrapElement(el: Element): UiElement {
  const wrapper = {
    get className() {
      return el.className;
    },
    set className(value: string) {
      el.className = value;
    },
    get textContent() {
      return el.textContent;
    },
    set textContent(value: string | null) {
      el.textContent = value;
    },
    get disabled() {
      return (el as unknown as { disabled?: boolean }).disabled;
    },
    set disabled(value: boolean | undefined) {
      (el as unknown as { disabled?: boolean }).disabled = value;
    },
    append(child: UiElement): void {
      el.append((child as unknown as { el: Element }).el);
    },
    addEventListener(type: "click", listener: (event: UiEvent) => void): void {
      el.addEventListener(type, listener as unknown as EventListener);
    },
  } as UiElement & { el: Element };
  wrapper.el = el;
  return wrapper;
}

/**
 * Real-DOM UiDocument adapter: created elements are wrappers around real nodes.
 */
export function browserUiDocument(root: Document = document): UiDocument {
  return {
    createElement: (tag: string) => wrapElement(root.createElement(tag)),
  };
}

