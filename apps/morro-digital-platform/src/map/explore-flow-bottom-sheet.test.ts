import { describe, expect, it, vi } from "vitest";
import {
  installExploreFlowBottomSheet,
  type ExploreFlowBottomSheetPresentation,
} from "./explore-flow-bottom-sheet.js";

/**
 * The explore/tour sheet is the surface the manual describes as the active map
 * panel, so its states are proved here without a browser: the fixture only
 * supplies DOM boundaries, never an alternative implementation of the sheet.
 */
class FixtureElement {
  className = "";
  textContent = "";
  hidden = false;
  style = { display: "block", visibility: "visible" };
  id = "";
  title = "";
  type = "";
  disabled = false;
  tabIndex = -1;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: FixtureElement[] = [];
  parent: FixtureElement | undefined;
  ownerDocument: FixtureDocument | undefined;
  isConnected = false;
  listeners = new Map<string, (event?: unknown) => void>();
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    toggle: (name: string, force?: boolean) => void;
    contains: (name: string) => boolean;
  };

  constructor(readonly tagName: string) {
    const read = (): Set<string> =>
      new Set(this.className.split(" ").filter(Boolean));
    const write = (names: Set<string>): void => {
      this.className = [...names].join(" ");
    };
    this.classList = {
      add: (...names: string[]) => {
        const current = read();
        for (const name of names) current.add(name);
        write(current);
      },
      remove: (...names: string[]) => {
        const current = read();
        for (const name of names) current.delete(name);
        write(current);
      },
      toggle: (name: string, force?: boolean) => {
        const current = read();
        const next = force ?? !current.has(name);
        if (next) current.add(name);
        else current.delete(name);
        write(current);
      },
      contains: (name: string) => read().has(name),
    };
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get parentElement(): FixtureElement | null {
    return this.parent ?? null;
  }

  private updateSubtree(connection: boolean): void {
    for (const node of [this, ...this.descendants()]) {
      node.ownerDocument = this.ownerDocument;
      node.isConnected = connection;
    }
  }

  appendChild(child: FixtureElement): FixtureElement {
    child.parent = this;
    this.children.push(child);
    child.updateSubtree(this.isConnected);
    return child;
  }

  append(...children: FixtureElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  prepend(child: FixtureElement): void {
    child.parent = this;
    this.children.unshift(child);
    child.updateSubtree(this.isConnected);
  }

  replaceChildren(...children: FixtureElement[]): void {
    for (const previous of this.children) {
      previous.parent = undefined;
      previous.updateSubtree(false);
    }
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = undefined;
    this.updateSubtree(false);
  }

  contains(node: FixtureElement): boolean {
    return this === node || this.descendants().includes(node);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes[name];
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  addEventListener(name: string, callback: (event?: unknown) => void): void {
    this.listeners.set(name, callback);
  }

  matches(selector: string): boolean {
    return (
      selector === ":disabled" &&
      (this.disabled ||
        this.ancestors().some(
          (ancestor) => ancestor.tagName === "fieldset" && ancestor.disabled,
        ))
    );
  }

  private ancestors(): FixtureElement[] {
    const result: FixtureElement[] = [];
    let parent = this.parentElement;
    while (parent) {
      result.push(parent);
      parent = parent.parentElement;
    }
    return result;
  }

  focus(): void {
    if (!this.ownerDocument || !this.isConnected || this.matches(":disabled"))
      return;
    if (
      [this, ...this.ancestors()].some(
        (node) =>
          node.hidden ||
          node.hasAttribute("inert") ||
          node.getAttribute("aria-hidden") === "true",
      )
    )
      return;
    this.ownerDocument.activeElement = this;
  }

  descendants(): FixtureElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelectorAll<HTMLElement>(selector: string): HTMLElement[] {
    const name = selector.startsWith(".") ? selector.slice(1) : selector;
    return this.descendants()
      .filter((node) =>
        selector.startsWith(".")
          ? node.classList.contains(name)
          : node.tagName === name,
      )
      .slice() as unknown as HTMLElement[];
  }
}

type FixtureDocument = Omit<
  Document,
  "activeElement" | "body" | "defaultView"
> & {
  body: FixtureElement;
  activeElement: FixtureElement | null;
  defaultView: {
    getComputedStyle: (element: FixtureElement) => FixtureElement["style"];
  };
};

// The controller narrows its children with `instanceof HTMLButtonElement`; the
// fixture supplies that marker so the real code path is exercised, not a stub.
class FixtureButton extends FixtureElement {}
Object.defineProperty(globalThis, "HTMLButtonElement", {
  value: FixtureButton,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "HTMLElement", {
  value: FixtureElement,
  configurable: true,
  writable: true,
});

const createDocument = (lang = "pt-BR"): FixtureDocument => {
  const body = new FixtureElement("body");
  const document = {
    body,
    activeElement: null,
    defaultView: {
      getComputedStyle: (element: FixtureElement) => element.style,
    },
    documentElement: { lang },
    createElement: (tag: string) => {
      const element =
        tag === "button" ? new FixtureButton(tag) : new FixtureElement(tag);
      element.ownerDocument = document;
      return element;
    },
    // No entry stylesheet marker: the feature-style gate runs actions inline.
    querySelector: () => null,
    addEventListener: () => {},
  } as unknown as FixtureDocument;
  body.ownerDocument = document;
  body.isConnected = true;
  return document;
};

const installSheet = (document: FixtureDocument) =>
  installExploreFlowBottomSheet({ document: document as unknown as Document });

const elementWithClass = (
  candidates: FixtureElement[],
  className: string,
): FixtureElement | undefined =>
  candidates.find((node) => node.classList.contains(className));

const sheetOf = (document: FixtureDocument): FixtureElement =>
  elementWithClass(document.body.descendants(), "explore-flow-bottom-sheet")!;

const statusOf = (document: FixtureDocument): FixtureElement =>
  elementWithClass(document.body.descendants(), "explore-flow-sheet-status")!;

const visibleText = (node: FixtureElement): string =>
  [node.textContent, ...node.descendants().map((child) => child.textContent)]
    .filter(Boolean)
    .join(" ");

const show = (
  controller: ReturnType<typeof installExploreFlowBottomSheet>,
  source: FixtureElement,
  overrides: Partial<ExploreFlowBottomSheetPresentation> = {},
): void => {
  controller.show({
    kind: "tour",
    accessibleLabel: "Roteiro do passeio",
    source: source as unknown as HTMLElement,
    onDismiss: () => {},
    ...overrides,
  });
};

describe("explore flow bottom sheet states", () => {
  it("names the failure plainly and keeps the preserved-filter hint", () => {
    const document = createDocument();
    const controller = installSheet(document);
    const source = new FixtureElement("div");
    show(controller, source, { status: "error" });

    const status = statusOf(document);
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(visibleText(status)).toContain("Não foi possível carregar.");
    expect(visibleText(status)).toContain("Seus filtros foram preservados");
    expect(status.classList.contains("hidden")).toBe(false);
    expect(
      elementWithClass(status.descendants(), "explore-flow-sheet-retry"),
    ).toBeUndefined();
    controller.destroy();
  });

  it("offers a retry that repeats the same request when one is available", () => {
    const document = createDocument();
    const controller = installSheet(document);
    const source = new FixtureElement("div");
    const retry = vi.fn();
    show(controller, source, { status: "error", onRetry: retry });

    const button = elementWithClass(
      statusOf(document).descendants(),
      "explore-flow-sheet-retry",
    )!;
    expect(button.type).toBe("button");
    expect(button.textContent).toBe("Tentar novamente");
    button.listeners.get("click")!();
    button.listeners.get("click")!();
    expect(retry).toHaveBeenCalledTimes(2);
    controller.destroy();
  });

  it("keeps a caller-provided reason ahead of the default sentence", () => {
    const document = createDocument();
    const controller = installSheet(document);
    const source = new FixtureElement("div");
    show(controller, source, {
      status: "error",
      statusText: "Não foi possível atualizar o mapa agora.",
    });
    const status = statusOf(document);
    expect(status.textContent ?? "").toBe("");
    const message = elementWithClass(
      status.descendants(),
      "explore-flow-sheet-status-message",
    )!;
    expect(message.textContent).toBe(
      "Não foi possível atualizar o mapa agora.",
    );
    controller.destroy();
  });

  it("renders a skeleton without inventing results while loading", () => {
    const document = createDocument();
    const controller = installSheet(document);
    const source = new FixtureElement("div");
    show(controller, source, { status: "loading" });

    const sheet = sheetOf(document);
    expect(sheet.getAttribute("aria-busy")).toBe("true");
    const status = statusOf(document);
    expect(
      elementWithClass(
        status.descendants(),
        "explore-flow-sheet-status-skeleton",
      ),
    ).toBeDefined();
    expect(elementWithClass(status.descendants(), "sr-only")!.textContent).toBe(
      "Atualizando o mapa e os resultados…",
    );
    controller.setStatus("ready");
    expect(sheet.getAttribute("aria-busy")).toBe("false");
    expect(statusOf(document).classList.contains("hidden")).toBe(true);
    controller.destroy();
  });

  it.each([
    ["pt-BR", "Não foi possível carregar.", "Tentar novamente"],
    ["en-US", "Could not load.", "Try again"],
    ["es-ES", "No se pudo cargar.", "Reintentar"],
    ["he-IL", "לא ניתן לטעון.", "נסו שוב"],
  ] as const)(
    "uses the localized recovery copy in %s",
    (lang, failure, retryLabel) => {
      const document = createDocument(lang);
      const controller = installSheet(document);
      const source = new FixtureElement("div");
      show(controller, source, { status: "error", onRetry: () => {} });
      const status = statusOf(document);
      expect(visibleText(status)).toContain(failure);
      expect(
        elementWithClass(status.descendants(), "explore-flow-sheet-retry")!
          .textContent,
      ).toBe(retryLabel);
      controller.destroy();
    },
  );

  it("reports the empty state without an invented result set", () => {
    const document = createDocument();
    const controller = installSheet(document);
    const source = new FixtureElement("div");
    show(controller, source, { status: "empty" });
    expect(visibleText(statusOf(document))).toBe(
      "Nenhum resultado encontrado para este filtro.",
    );
    controller.destroy();
  });

  it.each([
    ["pt-BR", "Controles de altura do painel", "Ações do passeio"],
    ["en-US", "Panel height controls", "Tour actions"],
    ["es-ES", "Controles de altura del panel", "Acciones del paseo"],
    ["he-IL", "פקדי גובה הלוח", "פעולות הסיור"],
  ] as const)(
    "names the panel control groups in %s",
    (lang, states, actions) => {
      const document = createDocument(lang);
      const controller = installSheet(document);
      show(controller, new FixtureElement("div"));

      const controls = sheetOf(document).descendants();
      expect(
        elementWithClass(
          controls,
          "explore-flow-sheet-state-controls",
        )?.getAttribute("aria-label"),
      ).toBe(states);
      expect(
        elementWithClass(controls, "explore-flow-sheet-actions")?.getAttribute(
          "aria-label",
        ),
      ).toBe(actions);
      controller.destroy();
    },
  );

  it("uses a place-specific accessible name for explore actions", () => {
    const document = createDocument();
    const controller = installSheet(document);
    show(controller, new FixtureElement("div"), { kind: "explore" });

    expect(
      elementWithClass(
        sheetOf(document).descendants(),
        "explore-flow-sheet-actions",
      )?.getAttribute("aria-label"),
    ).toBe("Ações do local");
    controller.destroy();
  });

  it("moves focus into the panel on open and restores it to a connected origin", () => {
    const document = createDocument();
    const origin = document.createElement("button") as unknown as FixtureButton;
    document.body.appendChild(origin);
    origin.focus();
    const controller = installSheet(document);

    show(controller, new FixtureElement("div"));
    const heading = elementWithClass(
      sheetOf(document).descendants(),
      "explore-flow-sheet-title",
    );
    expect(document.activeElement).toBe(heading);

    controller.hide();
    expect(document.activeElement).toBe(origin);
    controller.destroy();
  });

  it.each([
    "removed",
    "hidden",
    "inert",
    "aria-hidden",
    "disabled",
    "display-none",
    "visibility-hidden",
  ] as const)(
    "does not restore focus to an origin that became %s while the panel was open",
    (state) => {
      const document = createDocument();
      const origin = document.createElement(
        "button",
      ) as unknown as FixtureButton;
      document.body.appendChild(origin);
      origin.focus();
      const controller = installSheet(document);
      show(controller, new FixtureElement("div"));

      if (state === "removed") origin.remove();
      else if (state === "hidden") origin.hidden = true;
      else if (state === "inert") origin.setAttribute("inert", "");
      else if (state === "aria-hidden")
        origin.setAttribute("aria-hidden", "true");
      else if (state === "disabled") origin.disabled = true;
      else if (state === "display-none") origin.style.display = "none";
      else origin.style.visibility = "hidden";
      const heading = elementWithClass(
        sheetOf(document).descendants(),
        "explore-flow-sheet-title",
      );
      controller.hide();
      expect(document.activeElement).toBe(heading);
      controller.destroy();
    },
  );

  it.each([
    "hidden",
    "inert",
    "aria-hidden",
    "disabled",
    "aria-disabled",
  ] as const)("does not restore focus beneath an ancestor made %s", (state) => {
    const document = createDocument();
    const wrapper = new FixtureElement(
      state === "disabled" ? "fieldset" : "div",
    );
    const origin = document.createElement("button") as unknown as FixtureButton;
    wrapper.appendChild(origin);
    document.body.appendChild(wrapper);
    origin.focus();
    const controller = installSheet(document);
    show(controller, new FixtureElement("div"));

    if (state === "hidden") wrapper.hidden = true;
    else if (state === "inert") wrapper.setAttribute("inert", "");
    else if (state === "aria-hidden")
      wrapper.setAttribute("aria-hidden", "true");
    else if (state === "disabled") wrapper.disabled = true;
    else wrapper.setAttribute("aria-disabled", "true");
    controller.hide();

    expect(document.activeElement).not.toBe(origin);
    controller.destroy();
  });

  it("restores focus when the close button invokes a consumer that hides the panel", () => {
    const document = createDocument();
    const origin = document.createElement("button") as unknown as FixtureButton;
    document.body.appendChild(origin);
    origin.focus();
    const controller = installSheet(document);
    show(controller, new FixtureElement("div"), {
      onDismiss: () => controller.hide(),
    });

    elementWithClass(
      sheetOf(document).descendants(),
      "explore-flow-sheet-close",
    )!.listeners.get("click")!();
    expect(document.activeElement).toBe(origin);
    controller.destroy();
  });
});
