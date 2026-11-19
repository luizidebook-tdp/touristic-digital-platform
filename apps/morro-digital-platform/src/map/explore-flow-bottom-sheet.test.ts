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
  id = "";
  title = "";
  type = "";
  tabIndex = -1;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: FixtureElement[] = [];
  parent: FixtureElement | undefined;
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

  appendChild(child: FixtureElement): FixtureElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children: FixtureElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  prepend(child: FixtureElement): void {
    child.parent = this;
    this.children.unshift(child);
  }

  replaceChildren(...children: FixtureElement[]): void {
    for (const previous of this.children) previous.parent = undefined;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = undefined;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
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

  focus(): void {}

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

type FixtureDocument = Document & { body: FixtureElement };

// The controller narrows its children with `instanceof HTMLButtonElement`; the
// fixture supplies that marker so the real code path is exercised, not a stub.
class FixtureButton extends FixtureElement {}
Object.defineProperty(globalThis, "HTMLButtonElement", {
  value: FixtureButton,
  configurable: true,
  writable: true,
});

const createDocument = (lang = "pt-BR"): FixtureDocument => {
  const body = new FixtureElement("body");
  return {
    body,
    documentElement: { lang },
    createElement: (tag: string) =>
      tag === "button" ? new FixtureButton(tag) : new FixtureElement(tag),
    // No entry stylesheet marker: the feature-style gate runs actions inline.
    querySelector: () => null,
    addEventListener: () => {},
  } as unknown as FixtureDocument;
};

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
    const controller = installExploreFlowBottomSheet({ document });
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
    const controller = installExploreFlowBottomSheet({ document });
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
    const controller = installExploreFlowBottomSheet({ document });
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
    const controller = installExploreFlowBottomSheet({ document });
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
      const controller = installExploreFlowBottomSheet({ document });
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
    const controller = installExploreFlowBottomSheet({ document });
    const source = new FixtureElement("div");
    show(controller, source, { status: "empty" });
    expect(visibleText(statusOf(document))).toBe(
      "Nenhum resultado encontrado para este filtro.",
    );
    controller.destroy();
  });
});
