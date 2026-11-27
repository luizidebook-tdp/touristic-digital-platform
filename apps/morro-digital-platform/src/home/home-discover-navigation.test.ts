import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { ModuleKind, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";
import { manualSearchResultLabel } from "./manual-place-search.js";

class ElementFixture {
  children: ElementFixture[] = [];
  parent?: ElementFixture;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, (event: unknown) => void>();
  hidden = false;
  disabled = false;
  value = "";
  textContent = "";
  id = "";
  type = "";
  placeholder = "";
  onclick?: () => void;
  onsubmit?: (event: { preventDefault(): void }) => void;
  oninput?: () => void;
  onchange?: () => void;
  classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, enabled: boolean) =>
      enabled ? this.classes.add(name) : this.classes.delete(name),
  };
  constructor(readonly tagName: string) {}
  append(...nodes: ElementFixture[]) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: ElementFixture[]) {
    this.children = [];
    this.append(...nodes);
  }
  insertBefore(node: ElementFixture, before: ElementFixture) {
    node.parent = this;
    this.children.splice(this.children.indexOf(before), 0, node);
  }
  remove() {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  get options() {
    return this.children;
  }
  matches(selector: string) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const attr = selector.match(/^\[data-([a-z-]+)(?:="([^"]+)")?\]$/);
    if (attr) {
      const key = attr[1]!.replace(/-([a-z])/g, (_, c: string) =>
        c.toUpperCase(),
      );
      return (
        key in this.dataset &&
        (attr[2] === undefined || this.dataset[key] === attr[2])
      );
    }
    return this.tagName.toLowerCase() === selector;
  }
  querySelectorAll(selector: string): ElementFixture[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(selector: string): ElementFixture | null {
    return this.matches(selector)
      ? this
      : (this.parent?.closest(selector) ?? null);
  }
  addEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.set(type, fn);
  }
  removeEventListener(type: string) {
    this.listeners.delete(type);
  }
  focus() {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const settle = async () => {
  for (let n = 0; n < 10; n++) await Promise.resolve();
};
const places = Array.from({ length: 25 }, (_, index) => ({
  name: `Praia ${index + 1}`,
  category: "beaches",
  latitude: -13.38,
  longitude: -38.91,
}));

async function fixture() {
  const body = new ElementFixture("BODY");
  const nav = new ElementFixture("NAV");
  nav.id = "home-bottom-navigation";
  for (const action of ["explore", "tours", "saved"]) {
    const button = new ElementFixture("BUTTON");
    button.dataset.homeNavAction = action;
    nav.append(button);
  }
  body.append(nav);
  const document = {
    body,
    documentElement: { lang: "pt" },
    defaultView: { localStorage: { getItem: () => null } },
    getElementById: (id: string) => body.querySelector("#" + id),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    createElement: (tag: string) => new ElementFixture(tag.toUpperCase()),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  };
  let localeChanged = () => {};
  const execute = vi.fn(async (_command: unknown): Promise<boolean> => true);
  const search = vi.fn(
    async (_query: string, _category: string, _signal: AbortSignal) => ({
      source: "map",
      results: places,
    }),
  );
  const exports: Record<string, (...args: unknown[]) => { destroy(): void }> =
    {};
  const source = await readFile(
    new URL("./home-discover-navigation.ts", import.meta.url),
    "utf8",
  );
  runInNewContext(
    transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: 9 },
    }).outputText,
    {
      exports,
      AbortController,
      Element: ElementFixture,
      Event: class {},
      CustomEvent: class {},
      MutationObserver: class {
        constructor(callback: () => void) {
          localeChanged = callback;
        }
        observe() {}
        disconnect() {}
      },
      require: (name: string) => {
        if (name === "../map/feature-styles.js")
          return {
            createFeatureStyleGate: () => ({
              run: (fn: () => void) => fn(),
              cancel: () => {},
            }),
          };
        if (name === "./manual-place-search.js")
          return {
            createManualPlaceSearch: () => search,
            manualSearchResultLabel,
          };
        if (name === "../main.js")
          return {
            getMorroDigitalApplication: () => ({
              exploreLocations: { execute },
            }),
          };
        if (name === "@touristic/assistant")
          return {
            createAssistantUserProfileManager: () => ({
              getFavoritePlaces: () => [],
            }),
          };
        throw new Error("Unexpected import: " + name);
      },
    },
  );
  const controller = exports.installHomeDiscoverNavigation!({
    document,
    openPrivacyPreferences: () => {},
  });
  const panel = () => document.getElementById("home-manual-panel")!;
  const field = (tag: string) => panel().querySelector(tag)!;
  const open = (action = "tours") =>
    nav.listeners.get("click")!({
      target: nav.querySelector(`[data-home-nav-action="${action}"]`),
    });
  const submit = async (query = "Praia", category = "beaches") => {
    field("input").value = query;
    field("select").value = category;
    field("form").onsubmit!({ preventDefault() {} });
    await settle();
  };
  const rows = () =>
    panel()
      .querySelector("ul")!
      .children.map((row) => row.children[0]!);
  const close = () =>
    panel().children.find((child) => child.tagName === "BUTTON")!.onclick!();
  return {
    document,
    controller,
    execute,
    search,
    panel,
    field,
    open,
    submit,
    rows,
    close,
    locale: (lang: string) => {
      document.documentElement.lang = lang;
      localeChanged();
    },
  };
}

describe("Home search return context", () => {
  it("restores submitted results and query after selecting a place without a new search", async () => {
    const f = await fixture();
    f.open();
    await f.submit("Segunda Praia");
    f.rows()[0]!.onclick!();
    await settle();
    expect(f.panel().hidden).toBe(true);
    f.open();
    await settle();
    expect(f.field("input").value).toBe("Segunda Praia");
    expect(f.field("select").value).toBe("beaches");
    expect(f.rows()).toHaveLength(20);
    expect(f.search).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls.at(-1)![0]).toMatchObject({
      type: "show_search_results",
      query: "Segunda Praia",
    });
  });

  it("preserves an unsubmitted draft separately from the displayed snapshot", async () => {
    const f = await fixture();
    f.open();
    await f.submit();
    f.field("input").value = "Café";
    f.field("select").value = "restaurants";
    f.close();
    f.open();
    await settle();
    expect(f.field("input").value).toBe("Café");
    expect(f.field("select").value).toBe("restaurants");
    expect(f.rows()[0]!.textContent).toContain("Praia 1");
    expect(f.execute.mock.calls.at(-1)![0]).toMatchObject({
      query: "Praia",
      category: "beaches",
    });
    expect(f.search).toHaveBeenCalledTimes(1);
  });

  it("restores page two and waits for its map installation before showing selectable rows", async () => {
    const f = await fixture();
    f.open();
    await f.submit();
    f.panel().querySelector('[data-manual-page="next"]')!.onclick!();
    await settle();
    expect(f.rows()).toHaveLength(5);
    f.rows()[0]!.onclick!();
    await settle();
    const pending = deferred<boolean>();
    f.execute.mockImplementationOnce(() => pending.promise);
    f.open();
    await settle();
    expect(f.rows()).toHaveLength(0);
    expect(f.execute.mock.calls.at(-1)![0]).toMatchObject({
      results: places.slice(20),
    });
    pending.resolve(true);
    await settle();
    expect(f.rows()[0]!.textContent).toContain("Praia 21");
    f.rows()[0]!.onclick!();
    await settle();
    expect(f.execute.mock.calls.at(-1)![0]).toMatchObject({
      type: "select_place",
      place: "Praia 21",
    });
  });

  it("keeps search context across Saved and a hidden locale change", async () => {
    const f = await fixture();
    f.open();
    await f.submit();
    f.open("saved");
    f.locale("en");
    f.open();
    await settle();
    expect(f.field("input").value).toBe("Praia");
    expect(f.field("input").attributes.get("aria-label")).toBe("Place name");
    expect(f.rows()).toHaveLength(20);
    expect(f.search).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight search on close and ignores its later result", async () => {
    const f = await fixture();
    f.open();
    const pending = deferred<{ source: string; results: typeof places }>();
    f.search.mockImplementationOnce(() => pending.promise);
    await f.submit("Late");
    const signal = f.search.mock.calls[0]![2];
    f.close();
    f.open();
    pending.resolve({ source: "map", results: places });
    await settle();
    expect(signal.aborted).toBe(true);
    expect(f.field("input").value).toBe("Late");
    expect(f.rows()).toHaveLength(0);
  });

  it("ignores old page rejection, row and pager callbacks after reopening", async () => {
    const f = await fixture();
    f.open();
    await f.submit();
    const oldRow = f.rows()[0]!;
    const oldNext = f.panel().querySelector('[data-manual-page="next"]')!;
    const pending = deferred<boolean>();
    f.execute.mockImplementationOnce(() => pending.promise);
    oldNext.onclick!();
    await settle();
    f.close();
    f.open();
    await settle();
    const calls = f.execute.mock.calls.length;
    const status = f.panel().querySelector("p")!.textContent;
    oldRow.onclick!();
    oldNext.onclick!();
    pending.reject(new Error("Old map"));
    await settle();
    expect(f.execute).toHaveBeenCalledTimes(calls);
    expect(f.panel().querySelector("p")!.textContent).toBe(status);
    expect(f.panel().hidden).toBe(false);
  });

  it("does not repopulate a destroyed panel from a late map response", async () => {
    const f = await fixture();
    f.open();
    await f.submit();
    f.close();
    const pending = deferred<boolean>();
    f.execute.mockImplementationOnce(() => pending.promise);
    f.open();
    await settle();
    const panel = f.panel();
    f.controller.destroy();
    pending.resolve(true);
    await settle();
    expect(panel.querySelector("ul")!.children).toHaveLength(0);
  });

  it("keeps a new search status when the previous page request rejects", async () => {
    const f = await fixture();
    f.open();
    await f.submit();
    const page = deferred<boolean>();
    f.execute.mockImplementationOnce(() => page.promise);
    f.panel().querySelector('[data-manual-page="next"]')!.onclick!();
    await settle();
    const search = deferred<{ source: string; results: typeof places }>();
    f.search.mockImplementationOnce(() => search.promise);
    await f.submit("New query");
    const status = f.panel().querySelector("p")!.textContent;
    page.reject(new Error("Old page failed"));
    await settle();
    expect(f.panel().querySelector("p")!.textContent).toBe(status);
    search.resolve({ source: "map", results: places.slice(0, 1) });
    await settle();
    expect(f.rows()).toHaveLength(1);
  });

  it.each(["resolve", "reject"] as const)(
    "does not close or change a later search after old selection %s",
    async (outcome) => {
      const f = await fixture();
      f.open();
      await f.submit();
      const selection = deferred<boolean>();
      f.execute.mockImplementationOnce(() => selection.promise);
      f.rows()[0]!.onclick!();
      await settle();
      const search = deferred<{ source: string; results: typeof places }>();
      f.search.mockImplementationOnce(() => search.promise);
      await f.submit("Next");
      const signal = f.search.mock.calls.at(-1)![2];
      const status = f.panel().querySelector("p")!.textContent;
      if (outcome === "resolve") selection.resolve(true);
      else selection.reject(new Error("Old selection"));
      await settle();
      expect(f.panel().hidden).toBe(false);
      expect(signal.aborted).toBe(false);
      expect(f.panel().querySelector("p")!.textContent).toBe(status);
      search.resolve({ source: "map", results: places.slice(0, 1) });
      await settle();
      expect(f.rows()).toHaveLength(1);
    },
  );
});
