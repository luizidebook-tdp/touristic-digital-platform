import type { PublicPlaceCommerceProjection } from "@touristic/business";
import type { AssistantLocale } from "@touristic/assistant";

const copy = {
  pt: {
    products: "Produtos",
    offers: "Ofertas · preços de catálogo",
    menu: "Cardápio",
    unavailable: "Não há itens publicados disponíveis nesta seção.",
    offersUnavailable: "Não há ofertas publicadas.",
  },
  en: {
    products: "Products",
    offers: "Offers · catalog prices",
    menu: "Menu",
    unavailable: "No published items are available in this section.",
    offersUnavailable: "There are no published offers.",
  },
  es: {
    products: "Productos",
    offers: "Ofertas · precios de catálogo",
    menu: "Menú",
    unavailable: "No hay artículos publicados disponibles en esta sección.",
    offersUnavailable: "No hay ofertas publicadas.",
  },
  he: {
    products: "מוצרים",
    offers: "הצעות · מחירי קטלוג",
    menu: "תפריט",
    unavailable: "אין פריטים שפורסמו הזמינים בחלק זה.",
    offersUnavailable: "אין הצעות שפורסמו.",
  },
} as const;

/** Display only the server's published projection; never infer catalog from CMS counts. */
export function publicPlaceCatalogText(
  kind: "products" | "offers" | "menu",
  commerce: PublicPlaceCommerceProjection | null | undefined,
  locale: AssistantLocale,
): string {
  const labels = copy[locale];
  if (kind === "products") {
    const products = commerce?.products ?? [];
    return products.length
      ? [
          labels.products,
          ...products.map((product) =>
            [product.name, product.description].filter(Boolean).join(" — "),
          ),
        ].join("\n")
      : labels.unavailable;
  }
  if (kind === "offers") {
    const offers = commerce?.offers ?? [];
    return offers.length
      ? [
          labels.offers,
          ...offers.map((offer) => {
            const price = offer.price
              ? new Intl.NumberFormat(
                  { pt: "pt-BR", en: "en-US", es: "es-ES", he: "he-IL" }[
                    locale
                  ],
                  { style: "currency", currency: offer.price.currency },
                ).format(offer.price.minorUnits / 100)
              : "";
            return [offer.name, price, offer.description]
              .filter(Boolean)
              .join(" — ");
          }),
        ].join("\n")
      : labels.offersUnavailable;
  }
  const menu = commerce?.menu;
  if (!menu) return labels.unavailable;
  const localeTag = { pt: "pt-BR", en: "en-US", es: "es-ES", he: "he-IL" }[
    locale
  ];
  const lines = [menu.name || labels.menu, menu.description];
  if (
    !menu.categories.some((category) =>
      category.items.some((item) => item.available),
    )
  ) {
    lines.push(labels.unavailable);
  }
  for (const category of menu.categories) {
    const available = category.items.filter((item) => item.available);
    if (!available.length) continue;
    lines.push(category.name);
    for (const item of available) {
      const price = new Intl.NumberFormat(localeTag, {
        style: "currency",
        currency: item.price.currency,
      }).format(item.price.minorUnits / 100);
      lines.push(
        [item.name, price, item.description].filter(Boolean).join(" — "),
      );
    }
  }
  return lines.filter(Boolean).join("\n");
}
