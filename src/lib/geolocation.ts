export const GEOLOCATION_PERMISSION_DENIED = 1;
export const GEOLOCATION_POSITION_UNAVAILABLE = 2;
export const GEOLOCATION_TIMEOUT = 3;
export const LAST_KNOWN_LOCATION_KEY = "convoy.last_known_location";
export const GEOLOCATION_MAX_RETRIES = 5;
export const GEOLOCATION_RETRY_DELAY_MS = 1500;

export const INITIAL_POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 10_000,
};

export const WATCH_POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 10_000,
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

export type GeolocationPermissionState =
  | PermissionState
  | "unsupported"
  | "unknown";

export type ApproximateLocation = {
  lat: number;
  lng: number;
  city: string | null;
  region: string | null;
  country: string | null;
  source: "ipapi" | "ipwhois";
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

export async function getLocationPermissionState(): Promise<GeolocationPermissionState> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    console.log("Geolocation permission state:", "unsupported");
    return "unsupported";
  }

  if (!("permissions" in navigator) || !navigator.permissions?.query) {
    console.log("Geolocation permission state:", "unknown");
    return "unknown";
  }

  try {
    const permissionStatus = await navigator.permissions.query({
      name: "geolocation" as PermissionName,
    });
    console.log("Geolocation permission state:", permissionStatus.state);
    return permissionStatus.state;
  } catch (error) {
    console.warn("Unable to query geolocation permission state:", error);
    return "unknown";
  }
}

async function fetchWithTimeout(url: string, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchApproximateLocation(): Promise<ApproximateLocation | null> {
  try {
    const ipApiResponse = await fetchWithTimeout("https://ipapi.co/json/");
    if (ipApiResponse.ok) {
      const data = (await ipApiResponse.json()) as {
        latitude?: number;
        longitude?: number;
        city?: string | null;
        region?: string | null;
        country_name?: string | null;
      };

      if (typeof data.latitude === "number" && typeof data.longitude === "number") {
        return {
          lat: data.latitude,
          lng: data.longitude,
          city: data.city ?? null,
          region: data.region ?? null,
          country: data.country_name ?? null,
          source: "ipapi",
        };
      }
    }
  } catch (error) {
    console.warn("Approximate location lookup failed via ipapi:", error);
  }

  try {
    const ipWhoIsResponse = await fetchWithTimeout("https://ipwho.is/");
    if (ipWhoIsResponse.ok) {
      const data = (await ipWhoIsResponse.json()) as {
        success?: boolean;
        latitude?: number;
        longitude?: number;
        city?: string | null;
        region?: string | null;
        country?: string | null;
      };

      if (
        data.success !== false &&
        typeof data.latitude === "number" &&
        typeof data.longitude === "number"
      ) {
        return {
          lat: data.latitude,
          lng: data.longitude,
          city: data.city ?? null,
          region: data.region ?? null,
          country: data.country ?? null,
          source: "ipwhois",
        };
      }
    }
  } catch (error) {
    console.warn("Approximate location lookup failed via ipwho.is:", error);
  }

  return null;
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
