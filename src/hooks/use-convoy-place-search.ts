import { useEffect, useState } from "react";
import { parseCoordinateSuggestion, searchConvoyPlaces } from "@/lib/convoy-place-search";
import {
  getCuratedDestinationSuggestions,
  mergeDestinationSuggestions,
  type DestinationSuggestion,
} from "@/lib/destination-suggestions";

export function useConvoyPlaceSearch(input: string, enabled: boolean) {
  const query = enabled ? input.trim() : "";
  const [result, setResult] = useState<{
    query: string;
    places: DestinationSuggestion[];
    error: boolean;
  } | null>(null);
  const coordinates = parseCoordinateSuggestion(query);
  const shouldSearch = query.length >= 3 && !coordinates;

  useEffect(() => {
    if (!shouldSearch) return;
    const controller = new AbortController();
    let canceled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const debounce = setTimeout(async () => {
      timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const places = await searchConvoyPlaces(query, controller.signal);
        if (!canceled) setResult({ query, places, error: false });
      } catch {
        if (!canceled) setResult({ query, places: [], error: true });
      } finally {
        clearTimeout(timeout);
      }
    }, 450);

    return () => {
      canceled = true;
      clearTimeout(debounce);
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query, shouldSearch]);

  const current = shouldSearch && result?.query === query ? result : null;
  return {
    suggestions: coordinates ? [coordinates] : shouldSearch
      ? mergeDestinationSuggestions(current?.places ?? [], getCuratedDestinationSuggestions(query, 4))
      : [],
    searching: shouldSearch && !current,
    failed: current?.error ?? false,
  };
}
