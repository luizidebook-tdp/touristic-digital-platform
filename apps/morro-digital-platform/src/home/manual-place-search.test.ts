import { describe, expect, it, vi } from "vitest";
import {
  createManualPlaceSearch,
  manualSearchResultLabel,
} from "./manual-place-search.js";
import { getShellPresentationCopy } from "../runtime/shell-v1-i18n.js";
import { createPublicPlaceMapClient } from "../map/public-place-map-client-v2.js";
const place = (id: string, name: string) => ({
  id,
  name,
  category: "beaches",
  lat: -13.38,
  lng: -38.92,
  presentation: { markerKey: "beaches", priority: 1 },
});
const segundaPraia = {
  ...place("public-beach", "Segunda Praia"),
  lat: -13.3800508,
  lng: -38.9118443,
};
function client(pages: unknown[]) {
  const requests: string[] = [];
  const fetcher = vi.fn(async (url: string) => {
    requests.push(url);
    const page = pages.shift();
    if (page instanceof Error) throw page;
    return new Response(JSON.stringify(page), { status: 200 });
  });
  return {
    search: createManualPlaceSearch(
      createPublicPlaceMapClient(fetcher as typeof fetch),
    ),
    requests,
    fetcher,
  };
}
describe("manual search without an assistant or AI endpoint", () => {
  it("follows canonical cursors before local matching and never invents q", async () => {
    const run = client([
      { items: [place("one", "Primeira Praia")], nextCursor: "page2" },
      { items: [place("two", "Segunda Praia")], nextCursor: null },
    ]);
    const result = await run.search("segunda", "beaches");
    expect(result.source).toBe("canonical");
    expect(result.results.map((item) => item.placeId)).toEqual(["two"]);
    expect(run.requests).toHaveLength(2);
    for (const url of run.requests) {
      const parsed = new URL(url, "https://example.test");
      expect(parsed.pathname).toBe("/api/places/v1/map");
      expect(parsed.searchParams.get("category")).toBe("beaches");
      expect(parsed.searchParams.has("q")).toBe(false);
    }
    expect(
      new URL(run.requests[1]!, "https://example.test").searchParams.get(
        "cursor",
      ),
    ).toBe("page2");
  });
  it("keeps canonical empty distinct from unavailable local fallback", async () => {
    expect(
      await client([{ items: [], nextCursor: null }]).search("praia"),
    ).toEqual({ source: "canonical", results: [] });
    const unavailable = await client([new Error("offline")]).search("primeira");
    expect(unavailable.source).toBe("local");
    expect(unavailable.results.length).toBeGreaterThan(0);
    expect(
      unavailable.results.every(
        (item) => !item.placeId && item.source === "local",
      ),
    ).toBe(true);
  });
  it("finds an exact mapped beach after a complete public response without inventing a place ID", async () => {
    const snapshot = await client([{ items: [], nextCursor: null }]).search(
      "2a praia",
    );
    expect(snapshot.source).toBe("map");
    expect(snapshot.results).toHaveLength(1);
    expect(snapshot.results[0]).toMatchObject({
      name: "Segunda Praia",
      category: "beaches",
      source: "local",
    });
    expect(snapshot.results[0]?.placeId).toBeUndefined();
  });
  it("keeps the published beach identity for a catalog alias", async () => {
    const snapshot = await client([
      { items: [segundaPraia], nextCursor: null },
    ]).search("2a praia");
    expect(snapshot.source).toBe("canonical");
    expect(snapshot.results.map((row) => row.placeId)).toEqual([
      "public-beach",
    ]);
  });
  it("keeps a business with the same name separate from a mapped beach", async () => {
    const business = {
      ...place("restaurant", "Segunda Praia"),
      category: "restaurants",
    };
    const snapshot = await client([
      { items: [business], nextCursor: null },
    ]).search("Segunda Praia");
    expect(snapshot.results.map((row) => [row.category, row.placeId])).toEqual([
      ["beaches", undefined],
      ["restaurants", "restaurant"],
    ]);
  });
  it("does not transfer a catalog alias to a published homonym at another point", async () => {
    const other = place("other-beach", "Segunda Praia");
    const alias = await client([{ items: [other], nextCursor: null }]).search(
      "second beach",
    );
    expect(alias.source).toBe("map");
    expect(alias.results[0]).toMatchObject({
      source: "local",
      latitude: segundaPraia.lat,
      longitude: segundaPraia.lng,
    });
    const byName = await client([{ items: [other], nextCursor: null }]).search(
      "Segunda Praia",
    );
    expect(byName.results.map((row) => row.placeId)).toEqual([
      undefined,
      "other-beach",
    ]);
    expect(
      byName.results.map((row) =>
        manualSearchResultLabel(row, byName.results, "pt"),
      ),
    ).toEqual([
      "Segunda Praia · Praias · -13.3800508, -38.9118443",
      "Segunda Praia · Praias · -13.38, -38.92",
    ]);
  });
  it("preserves distinct published IDs when matching coordinates do not identify a unique profile", async () => {
    const records = [
      segundaPraia,
      { ...segundaPraia, id: "another-public-beach" },
    ];
    const snapshot = await client([
      { items: records, nextCursor: null },
    ]).search("Segunda Praia");
    expect(snapshot.results.map((row) => row.placeId)).toEqual([
      undefined,
      "public-beach",
      "another-public-beach",
    ]);
    const labels = snapshot.results.map((row) =>
      manualSearchResultLabel(row, snapshot.results, "pt"),
    );
    expect(new Set(labels).size).toBe(3);
  });
  it.each(["pt", "en", "es", "he"])(
    "disambiguates homonyms using the same category labels as the map in %s",
    async (locale) => {
      const restaurant = {
        ...segundaPraia,
        id: "business",
        category: "restaurants",
      };
      const snapshot = await client([
        { items: [restaurant], nextCursor: null },
      ]).search("Segunda Praia");
      const labels = getShellPresentationCopy(locale).assistantCategoryLabels;
      expect(
        snapshot.results.map((row) =>
          manualSearchResultLabel(row, snapshot.results, locale),
        ),
      ).toEqual([
        `Segunda Praia · ${labels.beaches}`,
        `Segunda Praia · ${labels.restaurants}`,
      ]);
      expect(
        manualSearchResultLabel(
          snapshot.results[0]!,
          [snapshot.results[0]!],
          locale,
        ),
      ).toBe("Segunda Praia");
    },
  );
  it("respects the selected category for an exact mapped beach", async () => {
    const snapshot = await client([{ items: [], nextCursor: null }]).search(
      "Segunda Praia",
      "restaurants",
    );
    expect(snapshot).toEqual({ source: "canonical", results: [] });
  });
  it("rejects an aborted request rather than disguising cancellation as fallback", async () => {
    const abort = new AbortController();
    abort.abort();
    const run = client([]);
    await expect(run.search("praia", "", abort.signal)).rejects.toBeDefined();
    expect(run.fetcher).not.toHaveBeenCalled();
  });
  it("does not label partial cyclic pagination as canonical complete", async () => {
    const run = client([
      { items: [place("one", "Remote only")], nextCursor: "cycle" },
      { items: [], nextCursor: "cycle" },
    ]);
    const result = await run.search("Remote only");
    expect(result.source).toBe("local");
    expect(result.results.some((item) => item.placeId === "one")).toBe(false);
    expect(run.fetcher).toHaveBeenCalledTimes(2);
  });
  it("deduplicates IDs and permits category browse with empty query", async () => {
    const run = client([
      { items: [place("one", "Praia")], nextCursor: "next" },
      { items: [place("one", "Praia atualizada")], nextCursor: null },
    ]);
    expect(
      (await run.search("", "beaches")).results.map((item) => item.name),
    ).toEqual(["Praia atualizada"]);
  });
  it("retains all25 canonical results for UI pagination rather than truncating20", async () => {
    const records = Array.from({ length: 25 }, (_, index) =>
      place(`place-${index}`, `Praia ${index}`),
    );
    const run = client([
      { items: records.slice(0, 13), nextCursor: "next" },
      { items: records.slice(13), nextCursor: null },
    ]);
    const snapshot = await run.search("Praia", "beaches");
    expect(snapshot.results).toHaveLength(25);
    expect(snapshot.results.map((item) => item.placeId).sort()).toEqual(
      records.map((item) => item.id).sort(),
    );
  });
  it("fails over honestly when canonical pagination exceeds20pages", async () => {
    const run = client(
      Array.from({ length: 20 }, (_, index) => ({
        items: [place(`remote-${index}`, "Remote only")],
        nextCursor: `cursor-${index}`,
      })),
    );
    const snapshot = await run.search("Remote only");
    expect(snapshot.source).toBe("local");
    expect(snapshot.results).toEqual([]);
    expect(run.fetcher).toHaveBeenCalledTimes(20);
  });
  it("rejects cancellation while canonical HTTP is in flight", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn(async () => {
      abort.abort();
      return new Response(
        JSON.stringify({ items: [place("one", "Praia")], nextCursor: null }),
      );
    });
    const search = createManualPlaceSearch(createPublicPlaceMapClient(fetcher));
    await expect(search("Praia", "", abort.signal)).rejects.toBeDefined();
  });
});
