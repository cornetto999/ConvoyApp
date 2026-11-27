import { isValidCoordinate } from "./convoy-position";
import type { DestinationSuggestion } from "./destination-suggestions";

type PhotonProperties = Partial<Record<
  "name" | "street" | "housenumber" | "locality" | "district" | "city" | "county" | "state" | "country" | "countrycode",
  string
>>;

export function coordinateSuggestion(lat: number, lng: number): DestinationSuggestion & { lat: number; lon: number } {
  return {
    display_name: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    lat,
    lon: lng,
    source: "search",
  };
}

export function parseCoordinateSuggestion(query: string) {
  const match = query.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return isValidCoordinate(lat, lng) ? coordinateSuggestion(lat, lng) : null;
}

export async function searchConvoyPlaces(query: string, signal: AbortSignal) {
  const coordinates = parseCoordinateSuggestion(query);
  if (coordinates) return [coordinates];

  const url = new URL(import.meta.env.VITE_PLACE_SEARCH_URL || "https://photon.komoot.io/api/");
  url.search = new URLSearchParams({
    q: query.trim(),
    countrycode: "PH",
    // Prefer Mindanao while allowing matches elsewhere in the Philippines.
    lat: "7.5",
    lon: "125.25",
    zoom: "7",
    limit: "7",
  }).toString();

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Place search failed (${response.status})`);
  const data = await response.json() as { features?: {
    properties?: PhotonProperties;
    geometry?: { type: string; coordinates?: [number, number] };
  }[] };
  if (!Array.isArray(data.features)) throw new Error("Invalid place search response");

  return data.features.flatMap((feature): DestinationSuggestion[] => {
    const { properties, geometry } = feature;
    const [lng, lat] = geometry?.coordinates ?? [];
    if (geometry?.type !== "Point" || !isValidCoordinate(lat, lng) || !properties
      || properties.countrycode?.toUpperCase() !== "PH") return [];

    const street = [properties.housenumber, properties.street].filter(Boolean).join(" ");
    const parts = [
      properties.name,
      street,
      properties.locality,
      properties.district,
      properties.city,
      properties.county,
      properties.state,
      properties.country,
    ].filter((part): part is string => Boolean(part));
    const uniqueParts = [...new Map(parts.map((part) => [part.toLowerCase(), part])).values()];
    if (uniqueParts.length < 2) return [];
    return [{ display_name: uniqueParts.join(", "), lat, lon: lng, source: "search" }];
  });
}
