export const GEOLOCATION_PERMISSION_DENIED = 1;
export const GEOLOCATION_POSITION_UNAVAILABLE = 2;
export const GEOLOCATION_TIMEOUT = 3;
export const LAST_KNOWN_LOCATION_KEY = "convoy.last_known_location";

export const INITIAL_POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 20_000,
};

export const WATCH_POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 20_000,
};

export type PersistedLocation = {
  lat: number;
  lng: number;
  heading: number;
  speed: number;
  updatedAt: number;
};

export type GeolocationErrorLike = {
  code?: number;
  message?: string | null;
};

type GeolocationMessageContext = "auth" | "tracking" | "locate";

export function getGeolocationErrorMessage(
  error: GeolocationErrorLike | null | undefined,
  context: GeolocationMessageContext = "tracking",
  retrying = false,
) {
  switch (error?.code) {
    case GEOLOCATION_PERMISSION_DENIED:
      return "Permission denied. Please allow location access.";
    case GEOLOCATION_POSITION_UNAVAILABLE:
      return retrying && context === "tracking"
        ? "Location unavailable. Try moving outdoors or enabling GPS."
        : "Location unavailable. Try moving outdoors or enabling GPS.";
    case GEOLOCATION_TIMEOUT:
      return "Location request timed out. Retrying...";
    default:
      return context === "auth"
        ? "Turn on location to use live convoy tracking and member speed updates."
        : "We couldn't determine your location yet. Try again in a moment.";
  }
}

export function getGeolocationUnsupportedMessage(context: GeolocationMessageContext = "tracking") {
  return context === "auth"
    ? "This device or browser doesn't support location access."
    : "This device or browser doesn't support live location.";
}

export function requestCurrentPosition(options?: PositionOptions) {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      reject({ message: getGeolocationUnsupportedMessage("auth") });
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

export function saveLastKnownLocation(location: PersistedLocation) {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(LAST_KNOWN_LOCATION_KEY, JSON.stringify(location));
}

export function getLastKnownLocation(maxAgeMs = 30 * 60 * 1000): PersistedLocation | null {
  if (typeof window === "undefined") return null;

  const raw = window.localStorage.getItem(LAST_KNOWN_LOCATION_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedLocation>;
    if (
      typeof parsed.lat !== "number" ||
      typeof parsed.lng !== "number" ||
      typeof parsed.heading !== "number" ||
      typeof parsed.speed !== "number" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }

    if (Date.now() - parsed.updatedAt > maxAgeMs) {
      return null;
    }

    return parsed as PersistedLocation;
  } catch {
    return null;
  }
}
