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
  POSITION_MAX_AGE_MS,
  selectConvoyFix,
  type ConvoyFix,
} from "@/lib/convoy-position";

// Allow time for a slow lock before restarting a silent watch.
const WATCH_SILENCE_MS = (WATCH_POSITION_OPTIONS.timeout ?? 10_000) + 2000;

export function useConvoyPosition(enabled: boolean) {
  const [fix, setFix] = useState<ConvoyFix | null>(null);
  const [stale, setStale] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [permission, setPermission] = useState<GeolocationPermissionState>("unknown");
  const [error, setError] = useState<number | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
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

    const geolocation = navigator.geolocation;
    let currentFix: ConvoyFix | null = null;
    let watchId: number | null = null;
    let revision = 0;
    let retries = 0;
    let disposed = false;
    let denied = false;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let permissionStatus: PermissionStatus | undefined;

    function stopWatch() {
      revision += 1;
      clearTimeout(restartTimer);
      restartTimer = undefined;
      clearTimeout(silenceTimer);
      if (watchId !== null) geolocation.clearWatch(watchId);
      watchId = null;
    }

    function handleDenial() {
      denied = true;
      stopWatch();
      clearTimeout(expiryTimer);
      currentFix = null;
      setFix(null);
      setStale(false);
      setPermission("denied");
      setError(GEOLOCATION_PERMISSION_DENIED);
    }

    function scheduleRetry(code: number) {
      setError(code);
      if (restartTimer || retries >= GEOLOCATION_MAX_RETRIES || document.hidden) return;
      restartTimer = setTimeout(() => {
        retries += 1;
        setAttempt(retries);
        if (import.meta.env.DEV) console.debug("Convoy GPS retry", { attempt: retries, code });
        startWatch();
      }, GEOLOCATION_RETRY_DELAY_MS);
    }

    function startWatch() {
      stopWatch();
      if (denied || document.hidden) return;
      const activeRevision = revision;
      silenceTimer = setTimeout(() => scheduleRetry(GEOLOCATION_TIMEOUT), WATCH_SILENCE_MS);
      watchId = geolocation.watchPosition(
        (position) => {
          if (activeRevision !== revision) return;
          const next = selectConvoyFix(currentFix, position);
          if (!next || next === currentFix) return;

          clearTimeout(silenceTimer);
          clearTimeout(restartTimer);
          restartTimer = undefined;
          clearTimeout(expiryTimer);
          retries = 0;
          currentFix = next;
          setFix(next);
          setStale(false);
          setPermission("granted");
          setAttempt(0);
          setError(null);
          expiryTimer = setTimeout(() => {
            setStale(true);
            // Keep the original fix visible as last known while recovering.
            scheduleRetry(GEOLOCATION_TIMEOUT);
          }, POSITION_MAX_AGE_MS - (Date.now() - next.timestamp));
          if (import.meta.env.DEV) console.debug("Convoy GPS fix", { accuracy: next.accuracy });
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

    function restart() {
      retries = 0;
      setAttempt(0);
      setError(null);
      startWatch();
    }

    function handleVisibility() {
      if (document.hidden) stopWatch();
      else if (!denied) restart();
    }

    function updatePermission() {
      if (!permissionStatus) return;
      const { state } = permissionStatus;
      if (state === "denied") {
        handleDenial();
      } else {
        setPermission(state);
        if (denied) {
          denied = false;
          restart();
        }
      }
    }

    retryRef.current = () => {
      denied = false;
      restart();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    startWatch();
    // Keep the browser's permission prompt inside the original request path.
    void navigator.permissions?.query({ name: "geolocation" }).then((status) => {
      if (disposed) return;
      permissionStatus = status;
      status.addEventListener("change", updatePermission);
      updatePermission();
    }).catch(() => {
      // Some Safari versions only report permission from watch callbacks.
    });

    return () => {
      disposed = true;
      stopWatch();
      clearTimeout(expiryTimer);
      permissionStatus?.removeEventListener("change", updatePermission);
      document.removeEventListener("visibilitychange", handleVisibility);
      retryRef.current = () => {};
    };
  }, [enabled]);

  return { fix, stale, attempt, permission, error, environmentError, retry: retryRef };
}
