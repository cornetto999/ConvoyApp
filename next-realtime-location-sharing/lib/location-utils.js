export const GPS_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 0
};

export const MAX_GPS_RETRIES = 5;
export const RETRY_DELAY_MS = 1500;
export const PRECISE_ACCURACY_METERS = 50;
export const APPROXIMATE_ACCURACY_METERS = 5000;
export const SYNC_INTERVAL_MS = 2500;

export function isLocalhost() {
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

export function requiresHttps() {
  if (typeof window === "undefined") return false;
  return window.location.protocol !== "https:" && !isLocalhost();
}

export async function getPermissionState() {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    console.log("Geolocation permission state: unsupported");
    return "unsupported";
  }

  if (!navigator.permissions || !navigator.permissions.query) {
    console.log("Geolocation permission state: prompt");
    return "prompt";
  }

  try {
    const result = await navigator.permissions.query({ name: "geolocation" });
    console.log("Geolocation permission state:", result.state);
    return result.state;
  } catch (error) {
    console.warn("Unable to read geolocation permission state:", error);
    return "prompt";
  }
}

async function fetchWithTimeout(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      }
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchApproximateLocation() {
  try {
    const ipApiResponse = await fetchWithTimeout("https://ipapi.co/json/");
    if (ipApiResponse.ok) {
      const ipApiData = await ipApiResponse.json();
      if (typeof ipApiData.latitude === "number" && typeof ipApiData.longitude === "number") {
        return {
          latitude: ipApiData.latitude,
          longitude: ipApiData.longitude,
          accuracy: APPROXIMATE_ACCURACY_METERS,
          label: [ipApiData.city, ipApiData.region, ipApiData.country_name]
            .filter(Boolean)
            .join(", "),
          source: "ipapi"
        };
      }
    }
  } catch (error) {
    console.warn("ipapi approximate lookup failed:", error);
  }

  try {
    const ipWhoIsResponse = await fetchWithTimeout("https://ipwho.is/");
    if (ipWhoIsResponse.ok) {
      const ipWhoIsData = await ipWhoIsResponse.json();
      if (
        ipWhoIsData.success !== false &&
        typeof ipWhoIsData.latitude === "number" &&
        typeof ipWhoIsData.longitude === "number"
      ) {
        return {
          latitude: ipWhoIsData.latitude,
          longitude: ipWhoIsData.longitude,
          accuracy: APPROXIMATE_ACCURACY_METERS,
          label: [ipWhoIsData.city, ipWhoIsData.region, ipWhoIsData.country]
            .filter(Boolean)
            .join(", "),
          source: "ipwhois"
        };
      }
    }
  } catch (error) {
    console.warn("ipwho.is approximate lookup failed:", error);
  }

  return null;
}

export function getErrorMessage(errorCode) {
  switch (errorCode) {
    case 1:
      return "Please enable location access in browser settings";
    case 2:
      return "Location unavailable. Retrying GPS...";
    case 3:
      return "Location request timed out. Retrying...";
    default:
      return "Unable to get location right now";
  }
}

export function getAccuracyStatus(accuracy) {
  if (typeof accuracy !== "number") {
    return "Getting precise location...";
  }

  if (accuracy < PRECISE_ACCURACY_METERS) {
    return "Location locked";
  }

  return "Improving accuracy...";
}

export function isPositionFresh(updatedAt, maxAgeMs = 15000) {
  if (!updatedAt) return false;
  return Date.now() - new Date(updatedAt).getTime() <= maxAgeMs;
}
