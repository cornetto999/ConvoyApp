import { useEffect, useRef, useState } from "react";
import {
  GEOLOCATION_MAX_RETRIES,
  GEOLOCATION_PERMISSION_DENIED,
  GEOLOCATION_POSITION_UNAVAILABLE,
  GEOLOCATION_RETRY_DELAY_MS,
  GEOLOCATION_TIMEOUT,
  getGeolocationUnsupportedMessage,
  WATCH_POSITION_OPTIONS,
  type GeolocationPermissionState,
} from "@/lib/geolocation";
import {
  isRoutingFix,
  POSITION_MAX_AGE_MS,
  selectConvoyFix,
  type ConvoyFix,
} from "@/lib/convoy-position";

// Allow time for a slow lock before restarting a silent watch.
const WATCH_SILENCE_MS = (WATCH_POSITION_OPTIONS.timeout ?? 10_000) + 2000;
const DEVICE_LOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: 0,
  timeout: 20_000,
};
const DEVICE_REQUEST_LIMIT_MS = 30_000;

type LocationPhase = "idle" | "requesting" | "locating" | "tracking" | "retrying" | "unavailable";

export function useConvoyPosition(enabled: boolean) {
  const [fix, setFix] = useState<ConvoyFix | null>(null);
  const [stale, setStale] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [permission, setPermission] = useState<GeolocationPermissionState>("unknown");
  const [error, setError] = useState<number | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [phase, setPhase] = useState<LocationPhase>("idle");
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    if (!window.isSecureContext) {
      setEnvironmentError("Open Convoy over HTTPS to use live location.");
      return;
    }
    if (!navigator.geolocation) {
      setPermission("unsupported");
      setEnvironmentError(getGeolocationUnsupportedMessage());
      return;
    }
    const documentPolicy = document as Document & {
      permissionsPolicy?: { allowsFeature: (feature: string) => boolean };
      featurePolicy?: { allowsFeature: (feature: string) => boolean };
    };
    const policy = documentPolicy.permissionsPolicy ?? documentPolicy.featurePolicy;
    if (policy?.allowsFeature("geolocation") === false) {
      setEnvironmentError("Location is blocked in this view. Open Convoy directly in your browser.");
      return;
    }

    const geolocation = navigator.geolocation;
    let currentFix: ConvoyFix | null = null;
    let watchId: number | null = null;
    let revision = 0;
    let retries = 0;
    let disposed = false;
    let permissionState: GeolocationPermissionState = "unknown";
    let requestActive = false;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    let permissionStatus: PermissionStatus | undefined;

    function stopAcquisition() {
      revision += 1;
      requestActive = false;
      clearTimeout(requestTimer);
      clearTimeout(restartTimer);
      restartTimer = undefined;
      clearTimeout(silenceTimer);
      if (watchId !== null) geolocation.clearWatch(watchId);
      watchId = null;
    }

    function clearFix() {
      clearTimeout(expiryTimer);
      currentFix = null;
      setFix(null);
      setStale(false);
    }

    function handleDenial() {
      permissionState = "denied";
      stopAcquisition();
      clearFix();
      setPermission("denied");
      setError(GEOLOCATION_PERMISSION_DENIED);
      setPhase("idle");
    }

    function scheduleRetry(code: number) {
      setError(code);
      if (restartTimer || document.hidden) return;
      if (retries >= GEOLOCATION_MAX_RETRIES) {
        // Leave the browser watch open in case it recovers without another request.
        setPhase("unavailable");
        return;
      }
      setPhase("retrying");
      restartTimer = setTimeout(() => {
        retries += 1;
        setAttempt(retries);
        if (import.meta.env.DEV) console.debug("Convoy GPS retry", { attempt: retries, code });
        startWatch();
      }, GEOLOCATION_RETRY_DELAY_MS);
    }

    function acceptPosition(position: GeolocationPosition) {
      const next = selectConvoyFix(currentFix, position);
      if (!next || next === currentFix) return;

      clearTimeout(silenceTimer);
      clearTimeout(restartTimer);
      restartTimer = undefined;
      clearTimeout(expiryTimer);
      retries = 0;
      currentFix = next;
      permissionState = "granted";
      setFix(next);
      setStale(false);
      setPermission("granted");
      setAttempt(0);
      setError(null);
      setPhase(isRoutingFix(next) ? "tracking" : "locating");
      expiryTimer = setTimeout(() => {
        setStale(true);
        if (watchId !== null) scheduleRetry(GEOLOCATION_TIMEOUT);
      }, POSITION_MAX_AGE_MS - (Date.now() - next.timestamp));
      if (import.meta.env.DEV) console.debug("Convoy GPS fix", { accuracy: next.accuracy });
    }

    function startWatch() {
      stopAcquisition();
      if (permissionState !== "granted" || document.hidden) return;
      setPhase(retries > 0 ? "retrying" : isRoutingFix(currentFix) ? "tracking" : "locating");
      const activeRevision = revision;
      silenceTimer = setTimeout(() => scheduleRetry(GEOLOCATION_TIMEOUT), WATCH_SILENCE_MS);
      watchId = geolocation.watchPosition(
        (position) => {
          if (activeRevision !== revision) return;
          acceptPosition(position);
        },
        (failure) => {
          if (activeRevision !== revision) return;
          clearTimeout(silenceTimer);
          if (failure.code === GEOLOCATION_PERMISSION_DENIED) {
            handleDenial();
            return;
          }
          scheduleRetry(failure.code || GEOLOCATION_POSITION_UNAVAILABLE);
        },
        WATCH_POSITION_OPTIONS,
      );
    }

    function requestDeviceLocation() {
      if (requestActive) return;
      stopAcquisition();
      retries = 0;
      setAttempt(0);
      setError(null);
      setPhase("requesting");
      requestActive = true;
      const activeRevision = revision;

      function handleFailure(code: number, fromBrowser = false) {
        if (activeRevision !== revision) return;
        if (code === GEOLOCATION_PERMISSION_DENIED) {
          handleDenial();
        } else if (!document.hidden && (permissionState === "granted"
          || (fromBrowser && permissionState === "unknown"))) {
          // A provider error also means permission was resolved on browsers
          // that do not expose its state.
          permissionState = "granted";
          setPermission("granted");
          startWatch();
        } else {
          stopAcquisition();
          setError(code);
          setPhase("unavailable");
        }
      }

      // Permission dialogs and embedded browsers can leave a request pending
      // without starting the browser's own position timeout.
      requestTimer = setTimeout(() => handleFailure(GEOLOCATION_TIMEOUT), DEVICE_REQUEST_LIMIT_MS);
      geolocation.getCurrentPosition((position) => {
        if (activeRevision !== revision) return;
        permissionState = "granted";
        setPermission("granted");
        acceptPosition(position);
        startWatch();
      }, (failure) => {
        handleFailure(failure.code || GEOLOCATION_POSITION_UNAVAILABLE, true);
      }, DEVICE_LOCATION_OPTIONS);
    }

    function handleVisibility() {
      if (document.hidden) {
        // A permission dialog can temporarily take focus away from the page.
        if (!requestActive) stopAcquisition();
      } else if (!requestActive && permissionState === "granted" && watchId === null) {
        retries = 0;
        setAttempt(0);
        setError(null);
        startWatch();
      }
    }

    function updatePermission() {
      if (!permissionStatus) return;
      const { state } = permissionStatus;
      if (state === "denied") {
        handleDenial();
      } else {
        permissionState = state;
        setPermission(state);
        if (state === "granted" && !requestActive && watchId === null) {
          retries = 0;
          setAttempt(0);
          setError(null);
          startWatch();
        } else if (state === "prompt" && !requestActive) {
          if (watchId !== null) stopAcquisition();
          clearFix();
          setError(null);
          setPhase("idle");
        }
      }
    }

    retryRef.current = requestDeviceLocation;
    document.addEventListener("visibilitychange", handleVisibility);
    void navigator.permissions?.query?.({ name: "geolocation" }).then((status) => {
      if (disposed) return;
      permissionStatus = status;
      status.addEventListener("change", updatePermission);
      updatePermission();
    }).catch(() => {
      // Browsers without a permission status can still request it from the button.
    });

    return () => {
      disposed = true;
      stopAcquisition();
      clearTimeout(expiryTimer);
      permissionStatus?.removeEventListener("change", updatePermission);
      document.removeEventListener("visibilitychange", handleVisibility);
      retryRef.current = () => {};
    };
  }, [enabled]);

  return { fix, stale, attempt, permission, error, environmentError, phase, retry: retryRef };
}
