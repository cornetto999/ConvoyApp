"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

import { GPS_OPTIONS, MAX_GPS_RETRIES, PRECISE_ACCURACY_METERS, RETRY_DELAY_MS, SYNC_INTERVAL_MS, fetchApproximateLocation, getAccuracyStatus, getErrorMessage, getPermissionState, isPositionFresh, requiresHttps } from "../lib/location-utils";
import { hasSupabaseEnv, supabase } from "../lib/supabase";

const HISTORY_LIMIT = 40;
const TrackingMap = dynamic(() => import("./tracking-map"), {
  ssr: false,
  loading: () => <div className="tracking-map loading-map">Loading live map...</div>
});

function getStoredUserId() {
  if (typeof window === "undefined") return null;

  const storedUserId = window.localStorage.getItem("realtime-location-user-id");
  if (storedUserId) return storedUserId;

  const randomId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  const generatedUserId = `user-${randomId}`;
  window.localStorage.setItem("realtime-location-user-id", generatedUserId);
  return generatedUserId;
}

function normalizeRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    accuracy: Number(row.accuracy || 0),
    updated_at: row.updated_at
  };
}

function isMobileBrowser() {
  if (typeof navigator === "undefined") return false;

  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

export default function LocationSharingClient({
  mode = "share",
  trackedUserId = null
}) {
  const isViewerMode = mode === "viewer";

  const [currentUserId, setCurrentUserId] = useState(trackedUserId);
  const [locationsByUser, setLocationsByUser] = useState({});
  const [historyByUser, setHistoryByUser] = useState({});
  const [permissionState, setPermissionState] = useState("unknown");
  const [trackingStatus, setTrackingStatus] = useState("Getting precise location...");
  const [connectionStatus, setConnectionStatus] = useState("Reconnecting...");
  const [errorMessage, setErrorMessage] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const [isApproximate, setIsApproximate] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [currentAccuracy, setCurrentAccuracy] = useState(null);
  const [currentCoords, setCurrentCoords] = useState(null);
  const [approximateLabel, setApproximateLabel] = useState("");
  const [geofenceMessage, setGeofenceMessage] = useState("");
  const [copiedLink, setCopiedLink] = useState(false);

  const watchIdRef = useRef(null);
  const retryTimeoutRef = useRef(null);
  const syncIntervalRef = useRef(null);
  const latestLocationRef = useRef(null);
  const retryAttemptRef = useRef(0);
  const retryScheduledRef = useRef(false);
  const subscriptionRef = useRef(null);
  const copyTimeoutRef = useRef(null);
  const geofenceCenterRef = useRef(null);
  const geofenceInsideRef = useRef(null);

  const isMobile = useMemo(() => isMobileBrowser(), []);

  const visibleLocations = useMemo(() => {
    const values = Object.values(locationsByUser)
      .filter(Boolean)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    if (!isViewerMode) return values;
    return values.filter((location) => location.user_id === trackedUserId);
  }, [isViewerMode, locationsByUser, trackedUserId]);

  const focusedUserId = isViewerMode ? trackedUserId : currentUserId;
  const targetLocation = focusedUserId ? locationsByUser[focusedUserId] : null;
  const displayedCoordinates = isViewerMode
    ? targetLocation
      ? {
          latitude: targetLocation.latitude,
          longitude: targetLocation.longitude
        }
      : null
    : currentCoords;
  const displayedAccuracy = isViewerMode
    ? targetLocation?.accuracy ?? null
    : currentAccuracy;

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined" || !currentUserId) return "";
    return `${window.location.origin}/track/${currentUserId}`;
  }, [currentUserId]);

  function clearRetryTimer() {
    if (retryTimeoutRef.current !== null) {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }

    retryScheduledRef.current = false;
  }

  function clearWatcher() {
    if (watchIdRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }

  function clearSyncTimer() {
    if (syncIntervalRef.current !== null) {
      window.clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
  }

  function updateHistory(userId, latitude, longitude) {
    setHistoryByUser((current) => {
      const previous = current[userId] || [];
      const lastPoint = previous[previous.length - 1];
      const nextPoint = [latitude, longitude];

      if (lastPoint && lastPoint[0] === latitude && lastPoint[1] === longitude) {
        return current;
      }

      return {
        ...current,
        [userId]: [...previous, nextPoint].slice(-HISTORY_LIMIT)
      };
    });
  }

  function mergeLocation(row) {
    const normalizedRow = normalizeRow(row);

    setLocationsByUser((current) => {
      const previous = current[normalizedRow.user_id];
      if (
        previous &&
        new Date(previous.updated_at).getTime() > new Date(normalizedRow.updated_at).getTime()
      ) {
        return current;
      }

      return {
        ...current,
        [normalizedRow.user_id]: normalizedRow
      };
    });

    updateHistory(normalizedRow.user_id, normalizedRow.latitude, normalizedRow.longitude);
  }

  function removeLocation(row) {
    if (!row?.user_id) return;

    setLocationsByUser((current) => {
      const next = { ...current };
      delete next[row.user_id];
      return next;
    });
  }

  function updateGeofence(latitude, longitude, shouldTrack) {
    if (!shouldTrack) return;

    if (!geofenceCenterRef.current) {
      geofenceCenterRef.current = { latitude, longitude, radiusMeters: 500 };
      geofenceInsideRef.current = true;
      return;
    }

    const center = geofenceCenterRef.current;
    const distanceMeters =
      Math.sqrt(
        Math.pow((latitude - center.latitude) * 111_320, 2) +
          Math.pow((longitude - center.longitude) * 111_320 * Math.cos((latitude * Math.PI) / 180), 2),
      );
    const isInside = distanceMeters <= center.radiusMeters;

    if (geofenceInsideRef.current === null) {
      geofenceInsideRef.current = isInside;
      return;
    }

    if (geofenceInsideRef.current !== isInside) {
      geofenceInsideRef.current = isInside;
      setGeofenceMessage(
        isInside
          ? "Geofence alert: you re-entered your 500 m tracking zone."
          : "Geofence alert: you moved outside your 500 m tracking zone.",
      );
    }
  }

  async function upsertLocation(payload) {
    if (!supabase || !payload?.user_id) return;

    // Keep a heartbeat moving even when coordinates do not change.
    const rowToSend = {
      ...payload,
      updated_at: new Date().toISOString()
    };

    console.log("Supabase upsert location:", rowToSend);

    const { error } = await supabase.from("locations").upsert(rowToSend, {
      onConflict: "user_id"
    });

    if (error) {
      console.error("Supabase upsert error:", error);
      setConnectionStatus("Reconnecting...");
      setErrorMessage("Realtime sync failed. Retrying...");
      return;
    }

    latestLocationRef.current = rowToSend;
    mergeLocation(rowToSend);
    setConnectionStatus("Live tracking active");
  }

  function applyLocation(location, source = "gps") {
    if (!currentUserId) return;

    const row = {
      user_id: currentUserId,
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      accuracy: Number(location.accuracy || 0),
      updated_at: new Date(location.timestamp || Date.now()).toISOString()
    };

    console.log("GPS success coordinates:", row);

    latestLocationRef.current = row;
    mergeLocation(row);
    updateGeofence(
      row.latitude,
      row.longitude,
      source === "gps" && row.accuracy < PRECISE_ACCURACY_METERS,
    );

    setCurrentCoords({
      latitude: row.latitude,
      longitude: row.longitude
    });
    setCurrentAccuracy(row.accuracy);
    setIsApproximate(source !== "gps");
    setApproximateLabel(source === "gps" ? "" : location.label || "");
    setTrackingStatus(
      source === "gps" ? getAccuracyStatus(row.accuracy) : "Approximate Location",
    );
    if (source === "gps") {
      setPermissionState((current) => (current === "denied" ? current : "granted"));
    }
    setConnectionStatus("Live tracking active");
    setErrorMessage("");
    setIsLoading(false);
    setRetryCount(0);
    retryAttemptRef.current = 0;
    retryScheduledRef.current = false;
    clearRetryTimer();

    void upsertLocation(row);
  }

  async function useApproximateFallback() {
    const approximateLocation = await fetchApproximateLocation();

    if (!approximateLocation) {
      console.warn("Approximate fallback unavailable");
      setTrackingStatus("Location unavailable");
      setConnectionStatus("Reconnecting...");
      setErrorMessage("Unable to get GPS or approximate location right now");
      setIsLoading(false);
      return;
    }

    console.log("Using approximate location:", approximateLocation);
    setTrackingStatus("Approximate Location");
    setApproximateLabel(approximateLocation.label || "your network area");

    applyLocation(
      {
        latitude: approximateLocation.latitude,
        longitude: approximateLocation.longitude,
        accuracy: approximateLocation.accuracy,
        label: approximateLocation.label,
        timestamp: Date.now()
      },
      "approximate",
    );
  }

  function scheduleRetry() {
    if (retryScheduledRef.current) return;
    if (retryAttemptRef.current >= MAX_GPS_RETRIES) return;

    const nextAttempt = retryAttemptRef.current + 1;
    retryAttemptRef.current = nextAttempt;
    retryScheduledRef.current = true;
    setRetryCount(nextAttempt);

    console.log(`Retrying GPS attempt ${nextAttempt}/${MAX_GPS_RETRIES} in ${RETRY_DELAY_MS}ms`);

    retryTimeoutRef.current = window.setTimeout(() => {
      retryScheduledRef.current = false;
      requestPreciseLocation();
    }, RETRY_DELAY_MS);
  }

  async function handleGeolocationError(error) {
    console.warn("Geolocation error:", error.code, error.message);

    if (error.code === 1) {
      clearRetryTimer();
      clearWatcher();
      setPermissionState("denied");
      setTrackingStatus("Location access blocked");
      setConnectionStatus("Reconnecting...");
      setErrorMessage("Please enable location access in browser settings");
      setIsLoading(false);
      await useApproximateFallback();
      return;
    }

    setErrorMessage(getErrorMessage(error.code));
    setConnectionStatus("Reconnecting...");
    setTrackingStatus(error.code === 3 ? "Improving accuracy..." : "Getting precise location...");

    if (retryAttemptRef.current < MAX_GPS_RETRIES) {
      scheduleRetry();
      return;
    }

    await useApproximateFallback();
  }

  function requestPreciseLocation() {
    if (!navigator.geolocation) return;

    // getCurrentPosition is still useful to trigger the browser prompt explicitly.
    clearRetryTimer();
    setTrackingStatus((current) =>
      current === "Approximate Location" ? "Improving accuracy..." : "Getting precise location...",
    );

    navigator.geolocation.getCurrentPosition(
      (position) => {
        applyLocation(
          {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp
          },
          "gps",
        );
      },
      (error) => {
        void handleGeolocationError(error);
      },
      GPS_OPTIONS,
    );
  }

  function startWatchTracking() {
    if (!navigator.geolocation) return;

    // watchPosition keeps the live trip marker moving after the initial permission prompt.
    clearWatcher();

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        applyLocation(
          {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp
          },
          "gps",
        );
      },
      (error) => {
        void handleGeolocationError(error);
      },
      GPS_OPTIONS,
    );
  }

  async function startTracking() {
    if (isViewerMode || !currentUserId) return;

    if (!hasSupabaseEnv || !supabase) {
      setTrackingStatus("Configuration required");
      setConnectionStatus("Reconnecting...");
      setErrorMessage("Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local");
      setIsLoading(false);
      return;
    }

    if (typeof window === "undefined") return;

    if (!navigator.geolocation) {
      setPermissionState("unsupported");
      setTrackingStatus("Location unavailable");
      setConnectionStatus("Reconnecting...");
      setErrorMessage("Geolocation is not supported in this browser");
      setIsLoading(false);
      await useApproximateFallback();
      return;
    }

    if (requiresHttps()) {
      setTrackingStatus("Location unavailable");
      setConnectionStatus("Reconnecting...");
      setErrorMessage("Geolocation requires HTTPS");
      setIsLoading(false);
      await useApproximateFallback();
      return;
    }

    const state = await getPermissionState();
    console.log("Permission state:", state);
    setPermissionState(state);

    if (state === "denied") {
      setTrackingStatus("Location access blocked");
      setConnectionStatus("Reconnecting...");
      setErrorMessage("Enable location access in browser settings");
      setIsLoading(false);
      await useApproximateFallback();
      return;
    }

    retryAttemptRef.current = 0;
    retryScheduledRef.current = false;
    setRetryCount(0);
    setErrorMessage("");
    setTrackingStatus("Getting precise location...");
    setConnectionStatus("Reconnecting...");
    setIsLoading(true);

    requestPreciseLocation();
    startWatchTracking();
  }

  async function loadInitialLocations() {
    if (!supabase) return;

    let query = supabase
      .from("locations")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(100);

    if (trackedUserId) {
      query = query.eq("user_id", trackedUserId);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Initial locations fetch failed:", error);
      setErrorMessage("Unable to load locations");
      return;
    }

    (data || []).forEach(mergeLocation);
  }

  function handleRetryTracking() {
    clearRetryTimer();
    clearWatcher();
    retryAttemptRef.current = 0;
    retryScheduledRef.current = false;
    setRetryCount(0);
    setTrackingStatus("Getting precise location...");
    setConnectionStatus("Reconnecting...");
    setErrorMessage("");
    setCopiedLink(false);
    void startTracking();
  }

  function handleUseMyLocationAgain() {
    setIsApproximate(false);
    setApproximateLabel("");
    setTrackingStatus("Getting precise location...");
    setConnectionStatus("Reconnecting...");
    setErrorMessage("");
    handleRetryTracking();
  }

  async function handleCopyShareLink() {
    if (!shareUrl || typeof navigator === "undefined" || !navigator.clipboard) return;

    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopiedLink(false);
      }, 1800);
    } catch (error) {
      console.warn("Copy share link failed:", error);
    }
  }

  useEffect(() => {
    if (isViewerMode) {
      setCurrentUserId(trackedUserId);
      return;
    }

    setCurrentUserId(getStoredUserId());
  }, [isViewerMode, trackedUserId]);

  useEffect(() => {
    if (!hasSupabaseEnv || !supabase || (!currentUserId && !trackedUserId)) {
      return undefined;
    }

    // Realtime updates let all viewers see marker changes instantly without polling.
    void loadInitialLocations();

    const channel = supabase
      .channel(trackedUserId ? `track-user-${trackedUserId}` : "realtime-location")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "locations",
          ...(trackedUserId ? { filter: `user_id=eq.${trackedUserId}` } : {})
        },
        (payload) => {
          console.log("Supabase realtime payload:", payload);

          if (payload.eventType === "DELETE") {
            removeLocation(payload.old);
            return;
          }

          if (payload.new) {
            mergeLocation(payload.new);
          }
        },
      )
      .subscribe((status) => {
        console.log("Supabase subscription status:", status);

        if (status === "SUBSCRIBED") {
          setConnectionStatus((current) =>
            current === "Live tracking active" ? current : "Realtime connected",
          );
          return;
        }

        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setConnectionStatus("Reconnecting...");
        }
      });

    subscriptionRef.current = channel;

    return () => {
      if (subscriptionRef.current && supabase) {
        supabase.removeChannel(subscriptionRef.current);
        subscriptionRef.current = null;
      }
    };
  }, [currentUserId, trackedUserId]);

  useEffect(() => {
    if (isViewerMode) {
      setIsLoading(false);
      return undefined;
    }

    if (!currentUserId) return undefined;

    void startTracking();

    clearSyncTimer();
    syncIntervalRef.current = window.setInterval(() => {
      if (!latestLocationRef.current) return;
      void upsertLocation(latestLocationRef.current);
    }, SYNC_INTERVAL_MS);

    const handleOnline = () => {
      console.log("Network back online, refreshing GPS");
      handleRetryTracking();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        console.log("Page visible, refreshing GPS");
        requestPreciseLocation();
        if (watchIdRef.current === null) {
          startWatchTracking();
        }
      }
    };

    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearRetryTimer();
      clearWatcher();
      clearSyncTimer();
      window.clearTimeout(copyTimeoutRef.current);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [currentUserId, isViewerMode]);

  const lastSeenLabel = targetLocation?.updated_at
    ? new Date(targetLocation.updated_at).toLocaleTimeString()
    : "No location yet";
  const gpsQualityLabel =
    typeof displayedAccuracy === "number"
      ? displayedAccuracy < PRECISE_ACCURACY_METERS
        ? "Precise location acquired"
        : "Low accuracy, improving..."
      : trackingStatus;
  const helperCopy = isViewerMode
    ? "Viewer mode stays synced through Supabase realtime updates."
    : isLoading
      ? "Getting your location..."
      : isMobile
        ? "Keep the page in the foreground for the most stable mobile GPS lock."
        : "Desktop browsers often use Wi-Fi positioning unless an external GPS is available.";

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">
            {isViewerMode ? "Shareable Tracking Link" : "Realtime Location Sharing"}
          </p>
          <h1>
            {isViewerMode
              ? `Tracking ${trackedUserId}`
              : "Google Maps or Grab style live location tracking"}
          </h1>
          <p className="subtitle">
            GPS-first tracking with <code>watchPosition</code>, Supabase realtime subscriptions,
            smooth Leaflet marker animation, and approximate IP fallback when GPS is still locking.
          </p>
        </div>

        {!isViewerMode && currentUserId && (
          <div className="share-card">
            <span className="share-label">Your user ID</span>
            <strong>{currentUserId}</strong>
            <span className="share-label">Shareable link</span>
            <a href={shareUrl}>{shareUrl}</a>
            <button type="button" className="secondary-button" onClick={handleCopyShareLink}>
              {copiedLink ? "Copied" : "Copy link"}
            </button>
          </div>
        )}
      </section>

      <section className="content-grid">
        <article className="status-panel">
          <div className="status-header">
            <div>
              <p className="panel-label">Tracking status</p>
              <h2>{isApproximate ? "Approximate Location" : trackingStatus}</h2>
            </div>
            <span className={`status-pill ${isPositionFresh(targetLocation?.updated_at) ? "live" : "idle"}`}>
              {isViewerMode
                ? isPositionFresh(targetLocation?.updated_at)
                  ? "Live tracking active"
                  : "Reconnecting..."
                : connectionStatus}
            </span>
          </div>

          <div className="status-list">
            <div>
              <span>Permission</span>
              <strong>{permissionState}</strong>
            </div>
            <div>
              <span>GPS quality</span>
              <strong>{gpsQualityLabel}</strong>
            </div>
            <div>
              <span>Retries</span>
              <strong>{retryCount}</strong>
            </div>
            <div>
              <span>Active users</span>
              <strong>{visibleLocations.length}</strong>
            </div>
            <div>
              <span>Last update</span>
              <strong>{lastSeenLabel}</strong>
            </div>
            <div>
              <span>Sync interval</span>
              <strong>{SYNC_INTERVAL_MS / 1000}s</strong>
            </div>
          </div>

          {displayedCoordinates && (
            <div className="coordinates-card">
              <div>
                <span>Latitude</span>
                <strong>{displayedCoordinates.latitude.toFixed(6)}</strong>
              </div>
              <div>
                <span>Longitude</span>
                <strong>{displayedCoordinates.longitude.toFixed(6)}</strong>
              </div>
              <div>
                <span>Accuracy</span>
                <strong>{Math.round(displayedAccuracy || 0)} m</strong>
              </div>
            </div>
          )}

          {approximateLabel && (
            <p className="approximate-note">
              Approximate Location based on {approximateLabel}. The app keeps watching GPS in the
              background and switches to live GPS automatically as soon as it locks.
            </p>
          )}

          {geofenceMessage && <p className="helper-copy">{geofenceMessage}</p>}
          {errorMessage && <p className="error-text">{errorMessage}</p>}

          <div className="action-row">
            {!isViewerMode && (
              <button type="button" onClick={handleRetryTracking}>
                Retry location
              </button>
            )}
            {!isViewerMode && isApproximate && (
              <button type="button" className="secondary-button" onClick={handleUseMyLocationAgain}>
                Use my location again
              </button>
            )}
            {isViewerMode && <Link href="/">Back to live sharing</Link>}
          </div>

          <p className="helper-copy">{helperCopy}</p>
          {!isMobile && !isViewerMode && (
            <p className="helper-copy">
              Desktop hint: browsers often fall back to Wi-Fi location. A phone or GPS-enabled
              tablet usually gives the best accuracy.
            </p>
          )}
        </article>

        <section className="map-panel">
          <TrackingMap
            locations={visibleLocations}
            histories={historyByUser}
            currentUserId={currentUserId}
            focusedUserId={focusedUserId}
          />

          <div className="map-legend">
            <span>OpenStreetMap tiles</span>
            <span>Blue = current sharer</span>
            <span>Green = other live users</span>
            <span>Accuracy circle = GPS confidence</span>
          </div>
        </section>
      </section>

      <section className="notes-grid">
        <article className="note-card">
          <h3>Realtime GPS</h3>
          <p>
            Uses <code>watchPosition</code> for continuous tracking and <code>getCurrentPosition</code>{" "}
            for explicit retry attempts and permission prompts.
          </p>
        </article>
        <article className="note-card">
          <h3>Battery-aware syncing</h3>
          <p>
            Location writes are throttled to every {SYNC_INTERVAL_MS / 1000} seconds so mobile
            devices stay responsive while the map keeps updating live through Supabase.
          </p>
        </article>
        <article className="note-card">
          <h3>Bonus behavior</h3>
          <p>
            Marker movement is animated, route history stays visible, and a simple 500 meter
            geofence alert fires when the tracked device leaves or re-enters its origin zone.
          </p>
        </article>
      </section>
    </main>
  );
}
