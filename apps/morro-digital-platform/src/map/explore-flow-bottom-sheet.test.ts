import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicPlaceDetail } from "@touristic/business";
import { asCategoryId, asPlaceId } from "@touristic/business";
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
  isConnected = true;
  textContent = "";
  focus = vi.fn();
  constructor(readonly tagName: string) {
    super();
  }
  append(...children: ElementStub[]) {
    this.children.push(...children);
  }
  appendChild(child: ElementStub) {
    this.append(child);
    return child;
  }
  replaceChildren(...children: ElementStub[]) {
    this.children.splice(0, this.children.length, ...children);
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  removeAttribute(key: string) {
    this.attributes.delete(key);
  }
  querySelectorAll() {
    return [];
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
  const body = new ElementStub("body");
  const document = {
    documentElement: { lang: "pt-BR" },
    body,
    createElement: (tag: string) => new ElementStub(tag),
    querySelector: () => null,
  } as unknown as Document;
  const returnFocus = new ElementStub("button");
  const card = new ElementStub("section");
  card.dataset.placeId = placeId;
  const original = new ElementStub("strong");
  card.append(original);
  body.append(card);
  const renderMedia = vi.fn(() => document.createElement("figure"));
  const sheet = installExploreFlowBottomSheet({ document });
  const show = (
    detail: PublicPlaceDetail = publication(),
    selectedId: string = placeId,
  ) =>
    sheet.showPlace({
      placeId: selectedId,
      detail,
      locale: "pt",
      renderMedia,
      card: card as unknown as HTMLElement,
      returnFocus: returnFocus as unknown as HTMLElement,
    } satisfies PublishedPlaceReading);
  return {
    body,
    sheet,
    card,
    original,
    returnFocus,
    renderMedia,
    show,
    document,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("published place reading on the Explore sheet", () => {
  it("uses the selected publication and keeps offer consultation local to the detail", () => {
    const f = fixture();
    const detail = publication();
    f.show(detail);
    expect(f.body.descendants("article")[0]?.dataset).toMatchObject({
      placeId,
      publicationRevision: "published-21",
    });
    expect(f.renderMedia).toHaveBeenCalledWith(
      f.document,
      detail.media,
      placeId,
      detail.profile.name,
      "pt",
    );
    expect(f.body.descendants("summary")[0]?.textContent).toBe("Ver ofertas");
    expect(f.body.descendants("p").map((e) => e.textContent)).toEqual([
      "Descrição publicada",
      "Ofertas · preços de catálogo",
      expect.stringMatching(/Experiência Pôr do Sol — R\$\s50,00/),
    ]);
    expect(f.body.descendants("a")).toHaveLength(0);
  });
  it("omits absent offers and invokes the existing missing-photo renderer", () => {
    const f = fixture(),
      d = publication();
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
    expect(f.body.descendants("details")).toHaveLength(0);
  });
  it("never shows media from another place or offers outside the published action scope", () => {
    const f = fixture(),
      d = publication();
    f.show({
      ...d,
      media: { ...d.media!, placeId: "other" },
      actions: {
        ...d.actions,
        secondaryActions: [
          {
            ...d.actions.secondaryActions[0]!,
            value: "place-action:offers:other",
          },
        ],
      },
    });
    expect(f.renderMedia).toHaveBeenCalledWith(
      f.document,
      null,
      placeId,
      d.profile.name,
      "pt",
    );
    expect(f.body.descendants("details")).toHaveLength(0);
  });
  it("rejects a mismatched selection, destination or unknown revision before rendering", () => {
    const f = fixture(),
      d = publication();
    f.show(d, "other");
    f.show({ ...d, actions: { ...d.actions, destinationId: "other" } });
    f.show({ ...d, revision: { id: "", number: 0 } });
    expect(f.body.descendants("article")).toHaveLength(0);
    expect(f.renderMedia).not.toHaveBeenCalled();
  });
  it("does not restore an old reading over a replacement selection", () => {
    const f = fixture();
    f.show();
    const back = f.card.descendants("button")[0]!;
    const replacement = new ElementStub("strong");
    f.card.dataset.placeId = "place-b";
    f.card.replaceChildren(replacement);
    back.dispatchEvent(new Event("click"));
    expect(f.card.firstChild).toBe(replacement);
    expect(f.returnFocus.focus).not.toHaveBeenCalled();
  });
  it.each(["click", "Escape"])(
    "returns to the original control without scrolling on %s",
    (method) => {
      const f = fixture();
      f.sheet.setState("full");
      f.show();
      const article = f.card.descendants("article")[0]!;
      if (method === "click") {
        const back = article
          .descendants("button")
          .find((e) => e.textContent === "Voltar ao local");
        expect(back).toBeDefined();
        back!.dispatchEvent(new Event("click"));
      } else {
        const ev = Object.assign(new Event("keydown", { cancelable: true }), {
          key: "Escape",
        });
        article.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
      }
      expect(f.card.firstChild).toBe(f.original);
      expect(f.sheet.getState()).toBe("full");
      expect(f.card.descendants("article")).toHaveLength(0);
      expect(f.returnFocus.focus).toHaveBeenCalledWith({ preventScroll: true });
    },
  );
});
