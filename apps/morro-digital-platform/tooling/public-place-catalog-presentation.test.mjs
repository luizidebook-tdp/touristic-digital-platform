import { describe, expect, it, vi } from "vitest";
import { publicPlaceCatalogText } from "../src/map/public-place-catalog-presentation.js";
// Executes the production catalog reader against the persisted-snapshot boundary.
import { createCatalogRuntime } from "./catalog-platform-runtime.mjs";

const place = {
  id: "place-a",
  businessId: "business-a",
  destinationId: "morro-de-sao-paulo",
};
const product = {
  id: "product-a",
  placeId: place.id,
  businessId: place.businessId,
  destinationId: place.destinationId,
  name: "Published product",
  description: "Public copy",
  status: "active",
};

describe("published catalog presentation", () => {
  it("projects only active products belonging to the selected published place", async () => {
    const execute = vi.fn(async () => [
      [
        {
          catalog_json: {
            products: [
              product,
              { ...product, id: "draft", status: "draft" },
              { ...product, id: "other-business", businessId: "business-b" },
              { ...product, id: "other-place", placeId: "place-b" },
              { ...product, id: "other-destination", destinationId: "itacare" },
            ],
            offers: [],
            menus: [],
          },
        },
      ],
    ]);
    const result = await createCatalogRuntime({ execute }).getPublicCommerce(
      place,
      16,
    );
    expect(result.products).toEqual([
      {
        id: "product-a",
        name: "Published product",
        description: "Public copy",
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, values] = execute.mock.calls[0];
    expect(sql).toContain("catalog_public_snapshots");
    expect(sql).toContain("snapshot.place_revision = ?");
    expect(values).toEqual([place.id, place.businessId, 16]);
    expect(publicPlaceCatalogText("products", result, "pt")).toContain(
      "Published product — Public copy",
    );
  });

  it("does not read editable catalog when a published snapshot is absent", async () => {
    const execute = vi.fn(async () => [[]]);
    const result = await createCatalogRuntime({ execute }).getPublicCommerce(
      place,
      16,
    );
    expect(result.products).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(publicPlaceCatalogText("products", result, "pt")).toContain(
      "Não há itens publicados",
    );
  });

  it.each(["pt", "en", "es", "he"])(
    "handles an empty projection and menu in %s",
    (locale) => {
      expect(publicPlaceCatalogText("products", null, locale)).toBeTruthy();
      expect(publicPlaceCatalogText("menu", undefined, locale)).toBeTruthy();
      const menu = {
        id: "menu",
        name: "Menu",
        description: "Published",
        fallbackMediaId: null,
        fallbackDocumentUrl: null,
        categories: [
          {
            id: "cat",
            name: "Drinks",
            items: [
              {
                id: "item",
                name: "Unavailable",
                description: "",
                price: { minorUnits: 100, currency: "BRL" },
                mediaId: null,
                available: false,
                tags: [],
                allergens: [],
              },
            ],
          },
        ],
      };
      expect(
        publicPlaceCatalogText("menu", { offers: [], menu }, locale),
      ).not.toContain("Unavailable");
    },
  );
});

it("does not present a fallback-only menu as usable item content", () => {
  const menu = {
    id: "menu",
    name: "Document menu",
    description: "",
    fallbackMediaId: "media-a",
    fallbackDocumentUrl: "https://example.test/menu.pdf",
    categories: [],
  };
  expect(publicPlaceCatalogText("menu", { offers: [], menu }, "pt")).toContain(
    "Não há itens publicados disponíveis nesta seção.",
  );
});
