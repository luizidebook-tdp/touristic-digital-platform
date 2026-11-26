import {
  morroV1SearchCatalog,
  normalizeSearchText,
  searchCatalog,
} from "@touristic/search";
import {
  createPublicPlaceMapClient,
  type PublicPlaceMapClient,
} from "../map/public-place-map-client-v2.js";
import type { ExploreSearchResult } from "../map/explore-locations-control.js";
import { getShellPresentationCopy } from "../runtime/shell-v1-i18n.js";

const BBOX = [-39.05, -13.5, -38.89, -13.35] as const;
export interface ManualSearchSnapshot {
  readonly source: "canonical" | "local" | "map";
  readonly results: readonly ExploreSearchResult[];
}

const localPlaces = morroV1SearchCatalog
  .filter(
    (item) =>
      item.longitude >= BBOX[0] &&
      item.longitude <= BBOX[2] &&
      item.latitude >= BBOX[1] &&
      item.latitude <= BBOX[3],
  )
  .map(({ name, category, latitude, longitude, aliases }) => ({
    name,
    category,
    latitude,
    longitude,
    ...(aliases ? { aliases } : {}),
    source: "local" as const,
  }));

function sameCoordinates(
  a: ExploreSearchResult,
  b: ExploreSearchResult,
): boolean {
  return a.latitude === b.latitude && a.longitude === b.longitude;
}

export function manualSearchResultLabel(
  place: ExploreSearchResult,
  results: readonly ExploreSearchResult[],
  locale: string,
): string {
  const name = normalizeSearchText(place.name);
  const homonyms = results.filter(
    (other) => other !== place && normalizeSearchText(other.name) === name,
  );
  if (!homonyms.length) return place.name;
  const categories: Readonly<Record<string, string>> =
    getShellPresentationCopy(locale).assistantCategoryLabels;
  const category = Object.hasOwn(categories, place.category)
    ? categories[place.category]
    : place.category;
  const parts = [place.name, category];
  const peers = homonyms.filter((other) => other.category === place.category);
  if (peers.length) {
    parts.push(`${place.latitude}, ${place.longitude}`);
    if (place.placeId && peers.some((other) => sameCoordinates(other, place)))
      parts.push(place.placeId);
  }
  return parts.join(" · ");
}

/** Searches the published map projection, not a private catalog or an AI service. */
export function createManualPlaceSearch(
  client: PublicPlaceMapClient = createPublicPlaceMapClient(),
) {
  return async (
    query: string,
    category = "",
    signal?: AbortSignal,
  ): Promise<ManualSearchSnapshot> => {
    const items = new Map<string, ExploreSearchResult>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    const filter = (rows: readonly ExploreSearchResult[]) => {
      const filtered = category
        ? rows.filter((item) => item.category === category)
        : rows;
      return query.trim()
        ? searchCatalog(filtered, query).map((match) => match.item)
        : filtered;
    };
    try {
      for (let page = 0; page < 20; page += 1) {
        signal?.throwIfAborted();
        const result = await client.listMap({
          destinationId: "morro-de-sao-paulo",
          bbox: BBOX,
          zoom: 13,
          ...(category ? { category } : {}),
          cursor,
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        for (const item of result.items)
          items.set(item.id, {
            name: item.name,
            category: item.category,
            latitude: item.lat,
            longitude: item.lng,
            placeId: item.id,
            source: "canonical",
          });
        if (result.nextCursor === null) {
          const published = [...items.values()];
          const normalized = normalizeSearchText(query);
          // Named beaches are map features even when they have no business profile.
          const beach =
            (!category || category === "beaches") && normalized
              ? localPlaces.find(
                  (row) =>
                    row.category === "beaches" &&
                    [row.name, ...(row.aliases ?? [])].some(
                      (alias) => normalizeSearchText(alias) === normalized,
                    ),
                )
              : undefined;
          if (beach) {
            const beachName = normalizeSearchText(beach.name);
            const samePlace = published.filter(
              (row) =>
                row.category === beach.category &&
                normalizeSearchText(row.name) === beachName &&
                sameCoordinates(row, beach),
            );
            // Apply a map alias to a published ID only when the match is unique.
            const first = samePlace.length === 1 ? samePlace[0]! : beach;
            return {
              source: first.source === "canonical" ? "canonical" : "map",
              results: [
                first,
                ...filter(published).filter((row) => row !== first),
              ],
            };
          }
          return { source: "canonical", results: filter(published) };
        }
        if (cursors.has(result.nextCursor))
          throw new Error("MANUAL_SEARCH_CURSOR_CYCLE");
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new Error("MANUAL_SEARCH_PAGE_LIMIT");
    } catch (error) {
      if (signal?.aborted) throw error;
      // The legacy index is explicitly local, with no canonical ID or availability claim.
      return { source: "local", results: filter(localPlaces) };
    }
  };
}
