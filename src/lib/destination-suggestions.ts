export type DestinationSuggestionCategory = "Tourist Spot" | "Barangay" | "Landmark";

export type DestinationSuggestion = {
  display_name: string;
  lat?: number;
  lon?: number;
  category?: DestinationSuggestionCategory;
  source: "curated" | "search";
};

type CuratedDestinationSuggestion = DestinationSuggestion & {
  keywords: string[];
};

const CURATED_DESTINATIONS: CuratedDestinationSuggestion[] = [
  {
    display_name: "Cloud 9 Boardwalk, General Luna, Siargao, Surigao del Norte, Philippines",
    lat: 9.8138,
    lon: 126.1592,
    category: "Tourist Spot",
    source: "curated",
    keywords: ["cloud 9", "siargao", "general luna", "surfing", "tourist spot"],
  },
  {
    display_name: "White Island, Mambajao, Camiguin, Philippines",
    lat: 9.2164,
    lon: 124.6757,
    category: "Tourist Spot",
    source: "curated",
    keywords: ["white island", "camiguin", "mambajao", "sandbar", "tourist spot"],
  },
  {
    display_name: "Hinatuan Enchanted River, Surigao del Sur, Philippines",
    lat: 8.4416,
    lon: 126.3364,
    category: "Tourist Spot",
    source: "curated",
    keywords: ["enchanted river", "hinatuan", "surigao del sur", "tourist spot"],
  },
  {
    display_name: "Tinuy-an Falls, Bislig, Surigao del Sur, Philippines",
    lat: 8.2353,
    lon: 126.3168,
    category: "Tourist Spot",
    source: "curated",
    keywords: ["tinuy-an falls", "bislig", "surigao del sur", "waterfall", "tourist spot"],
  },
  {
    display_name: "Dahican Beach, Mati, Davao Oriental, Philippines",
    lat: 6.8924,
    lon: 126.3076,
    category: "Tourist Spot",
    source: "curated",
    keywords: ["dahican beach", "mati", "davao oriental", "beach", "tourist spot"],
  },
  {
    display_name: "Lake Sebu Seven Falls, South Cotabato, Philippines",
    lat: 6.2254,
    lon: 124.7008,
    category: "Tourist Spot",
    source: "curated",
    keywords: ["lake sebu", "seven falls", "south cotabato", "tourist spot"],
  },
  {
    display_name: "Aliwagwag Falls Eco Park, Cateel, Davao Oriental, Philippines",
    lat: 7.425,
    lon: 126.5608,
    category: "Tourist Spot",
    source: "curated",
    keywords: ["aliwagwag falls", "cateel", "davao oriental", "waterfall", "tourist spot"],
  },
  {
    display_name: "Asik-Asik Falls, Alamada, Cotabato, Philippines",
    lat: 7.2845,
    lon: 124.8452,
    category: "Tourist Spot",
    source: "curated",
    keywords: ["asik-asik falls", "alamada", "cotabato", "tourist spot"],
  },
  {
    display_name: "Mount Apo Natural Park, Davao del Sur, Philippines",
    lat: 6.9892,
    lon: 125.2698,
    category: "Tourist Spot",
    source: "curated",
    keywords: ["mount apo", "apo natural park", "davao del sur", "mountain", "tourist spot"],
  },
  {
    display_name: "Tinago Falls, Linamon, Lanao del Norte, Philippines",
    lat: 8.1911,
    lon: 124.1975,
    category: "Tourist Spot",
    source: "curated",
    keywords: ["tinago falls", "linamon", "lanao del norte", "waterfall", "tourist spot"],
  },
];

function normalize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function withPublicShape(suggestion: CuratedDestinationSuggestion): DestinationSuggestion {
  const { keywords: _keywords, ...rest } = suggestion;
  return rest;
}

function getMatchScore(suggestion: CuratedDestinationSuggestion, query: string) {
  if (!query) return 1;

  const name = normalize(suggestion.display_name);
  const keywords = suggestion.keywords.map(normalize);

  if (name.startsWith(query)) return 5;
  if (keywords.some((keyword) => keyword.startsWith(query))) return 4;
  if (name.includes(query)) return 3;
  if (keywords.some((keyword) => keyword.includes(query))) return 2;

  return 0;
}

export function getQuickDestinationSuggestions(limit = 6) {
  return CURATED_DESTINATIONS.slice(0, limit).map(withPublicShape);
}

export function getCuratedDestinationSuggestions(query: string, limit = 6) {
  const normalizedQuery = normalize(query);

  return CURATED_DESTINATIONS
    .map((suggestion, index) => ({
      suggestion,
      index,
      score: getMatchScore(suggestion, normalizedQuery),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .slice(0, limit)
    .map((entry) => withPublicShape(entry.suggestion));
}

export function mergeDestinationSuggestions(
  curatedSuggestions: DestinationSuggestion[],
  remoteSuggestions: DestinationSuggestion[],
  limit = 8,
) {
  const merged: DestinationSuggestion[] = [];
  const seen = new Set<string>();

  for (const suggestion of [...curatedSuggestions, ...remoteSuggestions]) {
    const key = normalize(suggestion.display_name);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(suggestion);
    if (merged.length >= limit) break;
  }

  return merged;
}
