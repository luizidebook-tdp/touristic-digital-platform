import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicPlaceDetail } from "@touristic/business";
import { asCategoryId, asPlaceId } from "@touristic/business";
import { publicPlaceCatalogText } from "./public-place-catalog-presentation.js";
import {
  installExploreFlowBottomSheet,
  type PublishedPlaceReading,
} from "./explore-flow-bottom-sheet.js";

class ElementStub extends EventTarget {
  readonly children: ElementStub[] = [];
  get childNodes() {
    return this.children;
  }
  get firstChild(): ElementStub | null {
    return this.children[0] ?? null;
  }
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) =>
      names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]) =>
      names.forEach((name) => this.classes.delete(name)),
    toggle: (name: string, on: boolean) =>
      on ? this.classes.add(name) : this.classes.delete(name),
  };
  parentNode: ElementStub | null = null;
  get isConnected(): boolean {
    return this.tagName === "body" || !!this.parentNode?.isConnected;
  }
  get nextSibling(): ElementStub | null {
    const siblings = this.parentNode?.children;
    return siblings?.[siblings.indexOf(this) + 1] ?? null;
  }
  contains(node: ElementStub): boolean {
    return this === node || this.children.some((child) => child.contains(node));
  }
  remove() {
    if (ElementStub.focused && this.contains(ElementStub.focused))
      ElementStub.focused = null;
    const siblings = this.parentNode?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  insertBefore(child: ElementStub, sibling: ElementStub | null) {
    child.remove();
    this.children.splice(
      sibling ? this.children.indexOf(sibling) : this.children.length,
      0,
      child,
    );
    child.parentNode = this;
    return child;
  }
  disabled = false;
  textContent = "";
  static focused: ElementStub | null = null;
  get tabIndex(): number {
    const explicit = this.attributes.get("tabindex");
    return explicit === undefined
      ? this.tagName === "button"
        ? 0
        : -1
      : Number(explicit);
  }
  set tabIndex(value: number) {
    this.attributes.set("tabindex", String(value));
  }
  focus = vi.fn<(options?: FocusOptions) => void>(() => {
    if (
      this.isConnected &&
      !this.disabled &&
      (this.tagName === "button" || this.attributes.has("tabindex"))
    )
      ElementStub.focused = this;
  });
  constructor(readonly tagName: string) {
    super();
  }
  append(...children: ElementStub[]) {
    for (const child of children) this.insertBefore(child, null);
  }
  appendChild(child: ElementStub) {
    this.append(child);
    return child;
  }
  replaceChildren(...children: ElementStub[]) {
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  removeAttribute(key: string) {
    this.attributes.delete(key);
  }
  querySelectorAll(selector: string) {
    return selector === "button[data-value]"
      ? this.descendants("button").filter((b) => b.dataset.value)
      : [];
  }
  descendants(tagName: string): ElementStub[] {
    return this.children.flatMap((child) => [
      ...(child.tagName === tagName ? [child] : []),
      ...child.descendants(tagName),
    ]);
  }
}

const placeId = asPlaceId("place-pilot");
function publication(): PublicPlaceDetail {
  return {
    profile: {
      id: placeId,
      name: "Local do piloto",
      slug: "local-piloto",
      destinationId: "morro-de-sao-paulo",
      categoryId: asCategoryId("attractions"),
      subcategoryIds: [],
      shortDescription: "",
      description: "Descrição publicada",
      location: {
        latitude: -13.38,
        longitude: -38.92,
        address: "",
        area: "vila",
      },
      capabilities: [],
      amenities: [],
      tags: [],
      openingHours: null,
      contact: { email: null, phone: null, website: null, whatsapp: null },
    },
    revision: { id: "published-21", number: 21 },
    media: { placeId, coverImage: null, gallery: [], logo: null },
    partial: { actions: "ready", media: "ready", commerce: "ready" },
    commerce: {
      menu: null,
      offers: [
        {
          id: "offer-1",
          productId: "product-1",
          name: "Experiência Pôr do Sol",
          description: "",
          price: { currency: "BRL", minorUnits: 5000 },
          salesEndsAt: null,
        },
      ],
    },
    actions: {
      placeId,
      businessId: "business-a",
      destinationId: "morro-de-sao-paulo",
      primaryAction: null,
      secondaryActions: [
        {
          id: "offers",
          label: "Ver ofertas",
          value: `place-action:offers:${placeId}`,
          presentation: "secondary",
          priority: 20,
          disabled: false,
          availability: "available",
        },
      ],
    },
  };
}

function fixture() {
  vi.stubGlobal("HTMLButtonElement", ElementStub);
  ElementStub.focused = null;
  const body = new ElementStub("body");
  const document = {
    documentElement: { lang: "pt-BR" },
    get activeElement() {
      return ElementStub.focused;
    },
    body,
    createElement: (tag: string) => new ElementStub(tag),
    querySelector: () => null,
  } as unknown as Document;
  const card = new ElementStub("section");
  card.dataset.placeId = placeId;
  const actions = new ElementStub("div");
  const trigger = new ElementStub("button");
  trigger.textContent = "Ver ofertas";
  trigger.dataset.value = `place-action:offers:${placeId}`;
  actions.append(trigger);
  const after = new ElementStub("nav");
  after.tabIndex = -1;
  body.append(card, actions, after);
  const renderMedia = vi.fn<PublishedPlaceReading["renderMedia"]>(() =>
    document.createElement("figure"),
  );
  const sheet = installExploreFlowBottomSheet({ document });
  const show = (
    detail = publication(),
    selectedId: string = placeId,
    locale: PublishedPlaceReading["locale"] = "pt",
    close?: ElementStub,
  ) =>
    sheet.showPlace({
      placeId: selectedId,
      detail,
      locale,
      categoryLabel: locale === "en" ? "Attractions" : "Atrações",
      renderMedia,
      card: card as unknown as HTMLElement,
      actions: actions as unknown as HTMLElement,
      ...(close ? { close: close as unknown as HTMLElement } : {}),
    } satisfies PublishedPlaceReading);
  const read = (revisionId = "published-21", returnFocus = trigger) =>
    sheet.showPlaceAction({
      placeId,
      revisionId,
      content: (detail, locale) =>
        detail.partial.commerce === "ready"
          ? {
              title: detail.profile.name,
              text: publicPlaceCatalogText("offers", detail.commerce, locale),
            }
          : null,
      returnFocus: returnFocus as unknown as HTMLElement,
    });
  return {
    body,
    sheet,
    card,
    actions,
    trigger,
    after,
    renderMedia,
    show,
    read,
    document,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("published place reading on the Explore sheet", () => {
  it("keeps one operable Close above the place and its action, including language changes and Back", () => {
    const f = fixture();
    const detail = publication();
    const close = new ElementStub("button");
    const onClose = vi.fn();
    close.addEventListener("click", onClose);
    f.card.append(close);
    close.focus();
    f.show(detail, placeId, "pt", close);
    const original = f.card.descendants("article")[0];
    expect(f.card.children).toEqual([close, original]);
    expect(ElementStub.focused).toBe(close);
    expect(f.read()).toBe(true);
    const action = f.card.descendants("article")[0];
    expect(action).not.toBe(original);
    expect(f.card.children).toEqual([close, action]);
    close.dispatchEvent(new Event("click"));
    expect(onClose).toHaveBeenCalledOnce();
    close.focus();
    f.show(detail, placeId, "en", close);
    expect(f.card.children).toEqual([close, action]);
    expect(ElementStub.focused).toBe(close);
    const replacement = new ElementStub("button");
    f.show(detail, placeId, "en", replacement);
    expect(f.card.children).toEqual([replacement, action]);
    expect(ElementStub.focused).toBe(replacement);
    expect(f.sheet.backToPlace()).toBe(true);
    expect(f.card.children).toEqual([
      replacement,
      f.card.descendants("article")[0],
    ]);
    expect(ElementStub.focused).toBe(f.trigger);
  });

  it("renders one published card and moves the controller's actual buttons with their listeners", () => {
    const f = fixture();
    const detail = publication();
    const onSelect = vi.fn();
    f.trigger.addEventListener("click", onSelect);
    expect(f.show(detail)).toBe(true);
    expect(f.card.dataset).toMatchObject({
      placeId,
      publishedPlaceCard: "true",
      publicationRevision: "published-21",
    });
    expect(f.card.descendants("article")[0]?.dataset).toMatchObject({
      placeId,
      publicationRevision: "published-21",
    });
    expect(f.card.descendants("h2")[0]?.textContent).toBe(detail.profile.name);
    expect(f.card.descendants("p").map((e) => e.textContent)).toEqual([
      "Descrição publicada",
    ]);
    expect(f.card.descendants("button")).toEqual([f.trigger]);
    expect(
      f.body.descendants("button").filter((button) => button === f.trigger),
    ).toHaveLength(1);
    expect(f.renderMedia).toHaveBeenCalledWith(
      f.document,
      detail.media,
      placeId,
      detail.profile.name,
      "pt",
    );
    f.trigger.dispatchEvent(new Event("click"));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(f.trigger.focus).not.toHaveBeenCalled();
  });
  it("retains an empty authorized action set and uses the existing missing-photo renderer", () => {
    const f = fixture(),
      d = publication();
    f.actions.replaceChildren();
    f.show({
      ...d,
      media: null,
      commerce: { offers: [], menu: null },
      actions: { ...d.actions, secondaryActions: [] },
    });
    expect(f.renderMedia).toHaveBeenCalledWith(
      f.document,
      null,
      placeId,
      d.profile.name,
      "pt",
    );
    expect(f.card.descendants("button")).toHaveLength(0);
    expect(f.card.descendants("details")).toHaveLength(0);
  });
  it("rejects media from another place and media that is still partial", () => {
    const f = fixture(),
      d = publication();
    f.show({ ...d, media: { ...d.media!, placeId: "other" } });
    f.show({ ...d, partial: { ...d.partial, media: "unavailable" } });
    for (const call of f.renderMedia.mock.calls) expect(call[1]).toBeNull();
  });
  it("rejects a mismatched selection, destination or unknown revision before disturbing the current card", () => {
    const f = fixture(),
      d = publication();
    f.show();
    const current = f.card.firstChild;
    expect(f.show(d, "other")).toBe(false);
    expect(
      f.show({
        ...d,
        profile: { ...d.profile, destinationId: "" },
        actions: { ...d.actions, destinationId: "" },
      }),
    ).toBe(false);
    expect(
      f.show({ ...d, actions: { ...d.actions, destinationId: "other" } }),
    ).toBe(false);
    expect(f.show({ ...d, revision: { id: "", number: 0 } })).toBe(false);
    expect(f.show({ ...d, revision: { id: "published-20", number: 20 } })).toBe(
      false,
    );
    expect(f.show({ ...d, revision: { id: "conflict", number: 21 } })).toBe(
      false,
    );
    expect(f.show({ ...d, revision: { id: "published-21", number: 22 } })).toBe(
      false,
    );
    expect(f.card.firstChild).toBe(current);
    expect(f.renderMedia).toHaveBeenCalledTimes(1);
  });
  it.each(["click", "Escape", "controller"])(
    "returns from the subview to the same place, gallery and triggering button by %s",
    (method) => {
      const f = fixture();
      f.sheet.setState("full");
      f.show();
      const article = f.card.firstChild,
        gallery = f.card.descendants("figure")[0];
      expect(f.read()).toBe(true);
      expect(f.card.descendants("p").map((e) => e.textContent)).toEqual([
        "Ofertas · preços de catálogo",
        expect.stringMatching(/Experiência Pôr do Sol — R\$\s50,00/),
      ]);
      const back = f.card.descendants("button")[0]!;
      expect(back.textContent).toBe("Voltar ao local");
      expect(back.focus).toHaveBeenCalledWith({ preventScroll: true });
      if (method === "click") {
        back.dispatchEvent(new Event("click"));
      } else if (method === "Escape") {
        const ev = Object.assign(new Event("keydown", { cancelable: true }), {
          key: "Escape",
        });
        f.card.firstChild!.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
      } else {
        expect(f.sheet.backToPlace()).toBe(true);
      }
      expect(f.card.firstChild).toBe(article);
      expect(f.card.descendants("figure")[0]).toBe(gallery);
      expect(f.card.descendants("button")).toEqual([f.trigger]);
      expect(f.sheet.getState()).toBe("full");
      expect(f.trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(f.sheet.backToPlace()).toBe(false);
    },
  );
  it("retains an open action and its focused Back when the same revision is shown again", () => {
    const f = fixture();
    f.show();
    f.read();
    const current = f.card.firstChild,
      back = f.card.descendants("button")[0],
      calls = back!.focus.mock.calls.length;
    f.show();
    expect(f.card.firstChild).toBe(current);
    expect(ElementStub.focused).toBe(back);
    expect(back!.focus).toHaveBeenCalledTimes(calls);
    expect(f.sheet.backToPlace()).toBe(true);
    expect(ElementStub.focused).toBe(f.trigger);
    expect(f.renderMedia).toHaveBeenCalledTimes(1);
  });
  it("translates an open action in place and returns to its replacement control by value", () => {
    const f = fixture(),
      d = publication();
    f.show(d);
    f.read();
    const current = f.card.firstChild,
      back = f.card.descendants("button")[0]!;
    const replacement = new ElementStub("button");
    replacement.dataset.value = f.trigger.dataset.value!;
    replacement.textContent = "View offers";
    f.actions.replaceChildren(replacement);
    const translated = {
      ...d,
      profile: {
        ...d.profile,
        name: "Pilot place",
        description: "Published description",
      },
    };
    f.show(translated, placeId, "en");
    expect(f.card.firstChild).toBe(current);
    expect(f.card.descendants("button")[0]).toBe(back);
    expect(back.textContent).toBe("Back to place");
    expect(ElementStub.focused).toBe(back);
    expect(f.card.descendants("h2")[0]?.textContent).toBe("Pilot place");
    expect(f.card.descendants("p")[0]?.textContent).toBe(
      "Offers · catalog prices",
    );
    back.dispatchEvent(new Event("click"));
    expect(f.card.descendants("p")[0]?.textContent).toBe(
      "Published description",
    );
    expect(ElementStub.focused).toBe(replacement);
  });
  it("restores focus to the card when a focused action becomes unavailable", () => {
    const f = fixture();
    f.show();
    f.read();
    f.trigger.disabled = true;
    f.show();
    expect(f.sheet.backToPlace()).toBe(false);
    expect(f.card.attributes.get("tabindex")).toBe("-1");
    expect(ElementStub.focused).toBe(f.card);
  });
  it("keeps external focus during language changes and disappearance of the action", () => {
    const f = fixture(),
      d = publication();
    f.show(d);
    f.read();
    f.after.focus();
    f.show(
      { ...d, profile: { ...d.profile, name: "Pilot place" } },
      placeId,
      "en",
    );
    expect(ElementStub.focused).toBe(f.after);
    f.show(
      { ...d, partial: { ...d.partial, commerce: "unavailable" } },
      placeId,
      "en",
    );
    expect(f.sheet.backToPlace()).toBe(false);
    expect(ElementStub.focused).toBe(f.after);
    expect(f.card.descendants("h2")[0]?.textContent).toBe("Local do piloto");
  });
  it("rejects late action results and stale Back after a new revision of the same place", () => {
    const f = fixture(),
      d = publication();
    f.show();
    f.read();
    const oldBack = f.card.descendants("button")[0]!;
    f.show({ ...d, revision: { id: "published-22", number: 22 } });
    const article = f.card.firstChild;
    expect(f.read()).toBe(false);
    expect(f.read("published-22", new ElementStub("button"))).toBe(false);
    oldBack.dispatchEvent(new Event("click"));
    expect(f.card.firstChild).toBe(article);
    expect(f.trigger.focus).not.toHaveBeenCalled();
  });
  it("leaves a replacement card and keyboard focus untouched after the selection changes", () => {
    const f = fixture();
    f.show();
    f.read();
    const oldBack = f.card.descendants("button")[0]!,
      replacement = new ElementStub("strong");
    f.card.dataset.placeId = "another-place";
    f.card.replaceChildren(replacement);
    oldBack.dispatchEvent(new Event("click"));
    f.sheet.hide();
    expect(f.card.firstChild).toBe(replacement);
    expect(f.trigger.focus).not.toHaveBeenCalled();
  });
  it("returns the original action surface to its exact shell position when leaving the place", () => {
    const f = fixture();
    f.show();
    f.read();
    f.sheet.hide();
    expect(f.actions.parentNode).toBe(f.body);
    expect(f.actions.nextSibling).toBe(f.after);
    expect(f.card.dataset.publishedPlaceCard).toBeUndefined();
    expect(f.sheet.backToPlace()).toBe(false);
    expect(f.trigger.focus).not.toHaveBeenCalled();
  });
});
