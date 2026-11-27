import { isValidCoordinate, type Coordinate } from "./convoy-position";

export type RouteCoordinate = [number, number];
export type RouteOption = {
  coordinates: RouteCoordinate[];
  duration: number;
  distance: number;
  mode: "routed" | "direct";
};

const UNAVAILABLE = "Driving directions are unavailable right now.";
const NO_ROUTE = "No driving route connects these points. Try a starting point or entrance near a road.";

export function sameRoutePoint(a: Coordinate | null | undefined, b: Coordinate | null | undefined) {
  return a?.lat === b?.lat && a?.lng === b?.lng;
}

export function parseDrivingRoute(value: unknown): RouteOption | null {
  if (!value || typeof value !== "object") return null;
  const { coordinates, duration, distance } = value as Record<string, unknown>;
  if (!Array.isArray(coordinates) || coordinates.length < 2
    || !coordinates.every((point) => Array.isArray(point) && point.length === 2 && isValidCoordinate(point[1], point[0]))
    || typeof distance !== "number" || !Number.isFinite(distance) || distance < 0
    || typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return null;
  return { coordinates, duration, distance, mode: "routed" };
}

export function sameRoute(a: RouteOption | null | undefined, b: RouteOption | null | undefined) {
  if (!a || !b || a.mode !== b.mode || a.coordinates.length !== b.coordinates.length) return false;
  return a === b || a.coordinates.every(([lng, lat], index) => {
    const point = b.coordinates[index];
    return lng === point[0] && lat === point[1];
  });
}

export async function fetchDrivingRoutes(
  origin: Coordinate,
  destination: Coordinate,
  signal: AbortSignal,
  alternatives = false,
  via?: Coordinate,
): Promise<{ routes: RouteOption[]; message: string | null }> {
  if (signal.aborted) return { routes: [], message: UNAVAILABLE };

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 12_000);
  try {
    const points = via ? [origin, via, destination] : [origin, destination];
    const endpoints = points.map(({ lng, lat }) => `${lng},${lat}`).join(";");
    const params = new URLSearchParams({
      overview: "full",
      geometries: "geojson",
      alternatives: alternatives && !via ? "3" : "false",
      radiuses: points.map(() => "150").join(";"),
    });
    const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${endpoints}?${params}`, {
      signal: controller.signal,
    });
    const data = await response.json() as {
      code?: string;
      waypoints?: { distance: number }[];
      routes?: { geometry?: { coordinates: RouteCoordinate[] }; distance: number; duration: number }[];
    };
    if (data.code === "NoRoute" || data.code === "NoSegment") return { routes: [], message: NO_ROUTE };
    if (!response.ok || data.code !== "Ok" || !Array.isArray(data.routes)) {
      return { routes: [], message: UNAVAILABLE };
    }

    const routes: RouteOption[] = [];
    for (const result of data.routes) {
      const route = parseDrivingRoute({
        coordinates: result?.geometry?.coordinates,
        distance: result?.distance,
        duration: result?.duration,
      });
      if (route && !routes.some((previous) => sameRoute(previous, route))) routes.push(route);
    }
    if (!routes.length) return { routes: [], message: UNAVAILABLE };

    return {
      routes,
      message: Array.isArray(data.waypoints) && data.waypoints.some((waypoint) => waypoint?.distance > 40)
        ? "A route pin snapped to a nearby road. Check the pins and use an entrance for a closer match."
        : null,
    };
  } catch {
    return { routes: [], message: UNAVAILABLE };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

export function haversineMeters(a: Coordinate, b: Coordinate) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin((lat2 - lat1) / 2);
  const sinLon = Math.sin(toRad(b.lng - a.lng) / 2);
  const arc = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(arc, 1)));
}

export function formatDuration(seconds: number) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}
