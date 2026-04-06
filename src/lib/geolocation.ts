export const GEOLOCATION_PERMISSION_DENIED = 1;
export const GEOLOCATION_POSITION_UNAVAILABLE = 2;
export const GEOLOCATION_TIMEOUT = 3;

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
      return context === "auth"
        ? "Location access is off. Turn it on so convoy members can see your live position."
        : "Location access is off. Turn it on in your browser or device settings.";
    case GEOLOCATION_POSITION_UNAVAILABLE:
      if (retrying && context === "tracking") {
        return "Location is temporarily unavailable. Retrying while your device gets a GPS fix.";
      }

      return context === "locate"
        ? "Your current location is not available yet. Try again in a moment."
        : "Location is temporarily unavailable. Check GPS, signal, or device location services and try again.";
    case GEOLOCATION_TIMEOUT:
      if (retrying && context === "tracking") {
        return "Location request timed out. Retrying automatically.";
      }

      return context === "auth"
        ? "The location request took too long. You can continue now and enable location again later."
        : "Location request timed out. Try again in a moment.";
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
