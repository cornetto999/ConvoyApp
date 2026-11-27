import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LngLatBounds } from "maplibre-gl";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  LocateFixed,
  MapPin,
  Mountain,
  Navigation,
  RotateCcw,
  Ruler,
  Route as RouteIcon,
  Users,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConvoyPosition } from "@/hooks/use-convoy-position";
import { useConvoyPlaceSearch } from "@/hooks/use-convoy-place-search";
import { coordinateSuggestion, parseCoordinateSuggestion } from "@/lib/convoy-place-search";
import {
  accuracyOutline,
  formatLiveSpeed,
  isRoutingFix,
  isValidCoordinate,
  POSITION_MAX_AGE_MS,
  type Coordinate,
} from "@/lib/convoy-position";
import { getQuickDestinationSuggestions, type DestinationSuggestion } from "@/lib/destination-suggestions";
import { getGeolocationErrorMessage } from "@/lib/geolocation";
import {
  fetchDrivingRoutes,
  formatDistance,
  formatDuration,
  haversineMeters,
  parseDrivingRoute,
  sameRoute,
  sameRoutePoint,
  type RouteCoordinate,
  type RouteOption,
} from "@/lib/convoy-routing";
import {
  Map as AppMap,
  MapClusterLayer,
  MapControls,
  MapMarker,
  MapPopup,
  MapRoute,
  MarkerContent,
  MarkerLabel,
  MarkerPopup,
  type MapRef,
  type MapViewport,
} from "@/components/ui/map";
import type { Convoy, ConvoyMember, MemberLocation, Profile } from "@/types/convoy";
import type { Tables } from "@/integrations/supabase/types";

type MemberWithProfile = ConvoyMember & { profiles: Profile | null };
type NamedCoordinate = Coordinate & { name: string };
type RouteSearch = {
  origin: Coordinate;
  destination: Coordinate;
  via: Coordinate | null;
  options: { route: RouteOption; via: boolean }[];
  message: string | null;
  viaMessage: string | null;
};
type SpeedPointProperties = {
  userId: string;
  name: string;
  speedLabel: string;
  role: string;
  updatedAt: string;
};
type GapAlert = {
  userId: string;
  name: string;
  coordinates: RouteCoordinate;
  gapMeters: number;
};
const DEFAULT_CENTER: Coordinate = { lat: 7.0731, lng: 125.6128 };
const DEFAULT_VIEWPORT: MapViewport = {
  center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
  zoom: 13,
  bearing: 0,
  pitch: 0,
};
const REROUTE_THRESHOLD_METERS = 50;
const FOLLOW_THRESHOLD_METERS = 3;
const LIVE_ORIGIN_LABEL = "Your location";
const ROUTE_COLORS = ["#6366f1", "#0ea5e9", "#f97316", "#e879f9", "#fbbf24"];
const SHARED_ROUTE_COLOR = "#22c55e";

function isMemberLocationStale(updatedAt: string, now: number) {
  const timestamp = Date.parse(updatedAt);
  return !Number.isFinite(timestamp) || timestamp + POSITION_MAX_AGE_MS <= now;
}

function MemberSpeedLabel({ speed, stale }: { speed: number | null; stale: boolean }) {
  return (
    <MarkerLabel className={`pointer-events-none mb-2 rounded-full border border-border/70 bg-background/95 px-2 py-0.5 font-semibold tabular-nums shadow-sm ${stale || speed === null ? "text-muted-foreground" : ""}`}>
      {formatLiveSpeed(speed, stale)}
    </MarkerLabel>
  );
}

function getBearingDegrees(from: Coordinate, to: Coordinate) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const toDeg = (value: number) => (value * 180) / Math.PI;

  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const deltaLon = toRad(to.lng - from.lng);

  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);

  return ((toDeg(Math.atan2(y, x)) + 360) % 360) - 15;
}

function ConvoyMarkerPin({
  color,
  label,
  pulse = false,
  stale = false,
}: {
  color: string;
  label: string;
  pulse?: boolean;
  stale?: boolean;
}) {
  return (
    <div className="relative flex flex-col items-center">
      {pulse && (
        <span
          className="absolute top-3 h-7 w-7 rounded-full opacity-25 animate-ping"
          style={{ backgroundColor: color }}
        />
      )}
      <div
        className="relative flex h-9 w-9 items-center justify-center rounded-full border-2 border-white text-xs font-black text-white shadow-xl"
        style={{ backgroundColor: color }}
      >
        {label}
        {stale && (
          <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full border-2 border-background bg-destructive" />
        )}
      </div>
      <div
        className="-mt-1 h-3 w-3 rotate-45 rounded-[2px] border-r-2 border-b-2 border-white shadow-md"
        style={{ backgroundColor: color }}
      />
    </div>
  );
}

/** Google Maps–style GPS blue dot with heading direction cone */
function CurrentLocationMarker({ heading, precise }: { heading: number | null; precise: boolean }) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: 56, height: 56 }}>
      {/* Accuracy pulse ring */}
      <span
        className={precise ? "absolute inset-0 rounded-full motion-safe:animate-ping" : "hidden"}
        style={{ backgroundColor: "rgba(59,130,246,0.18)", animationDuration: "2s" }}
      />
      {/* Soft glow halo */}
      <span
        className="absolute rounded-full"
        style={{
          width: 36,
          height: 36,
          background: "radial-gradient(circle, rgba(59,130,246,0.25) 0%, transparent 70%)",
        }}
      />
      {/* Heading cone - points in direction of travel */}
      {heading !== null && precise && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ transform: `rotate(${heading}deg)` }}
        >
          <div
            style={{
              width: 0,
              height: 0,
              borderLeft: "7px solid transparent",
              borderRight: "7px solid transparent",
              borderBottom: "22px solid rgba(59,130,246,0.55)",
              position: "absolute",
              bottom: "50%",
              marginBottom: 10,
            }}
          />
        </div>
      )}
      {/* Blue dot */}
      <div
        className="relative z-10 rounded-full border-[3px] border-white shadow-lg"
        style={{
          width: 20,
          height: 20,
          background: precise ? "#2563eb" : "#64748b",
          boxShadow: "0 2px 8px rgba(59,130,246,0.6), 0 0 0 3px white",
        }}
      />
    </div>
  );
}

/** Destination flag pin with a proper pin shape */
function DestinationMarker({ label }: { label?: string }) {
  return (
    <div className="relative flex flex-col items-center" style={{ transform: "translateY(-4px)" }}>
      {/* Label chip */}
      {label && (
        <div
          className="absolute whitespace-nowrap rounded-full border border-border/80 bg-background/95 px-2.5 py-1 text-[11px] font-semibold shadow-md backdrop-blur-sm"
          style={{ bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)" }}
        >
          {label}
        </div>
      )}
      {/* Pin body */}
      <div
        className="flex items-center justify-center rounded-full border-2 border-white text-white shadow-xl"
        style={{
          width: 36,
          height: 36,
          background: "linear-gradient(135deg, #f43f5e 0%, #be123c 100%)",
          boxShadow: "0 4px 12px rgba(244,63,94,0.5), 0 0 0 2px white",
        }}
      >
        {/* Flag icon */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6h-5.6z" />
        </svg>
      </div>
      {/* Pin tail */}
      <div
        style={{
          width: 3,
          height: 10,
          background: "linear-gradient(to bottom, #be123c, rgba(190,18,60,0.3))",
          borderRadius: "0 0 2px 2px",
          marginTop: -1,
        }}
      />
      {/* Pin shadow */}
      <div
        style={{
          width: 10,
          height: 3,
          background: "radial-gradient(ellipse, rgba(0,0,0,0.25) 0%, transparent 70%)",
          marginTop: 1,
        }}
      />
    </div>
  );
}

function ViewportHud({ viewport }: { viewport: MapViewport }) {
  return (
    <div className="bg-background/85 absolute top-3 left-3 z-20 flex max-w-[calc(100vw-2rem)] flex-wrap gap-x-3 gap-y-1 rounded-lg border px-3 py-2 font-mono text-[11px] shadow-lg backdrop-blur">
      <span>
        <span className="text-muted-foreground">lng:</span>{" "}
        {viewport.center[0].toFixed(3)}
      </span>
      <span>
        <span className="text-muted-foreground">lat:</span>{" "}
        {viewport.center[1].toFixed(3)}
      </span>
      <span>
        <span className="text-muted-foreground">zoom:</span>{" "}
        {viewport.zoom.toFixed(1)}
      </span>
      <span>
        <span className="text-muted-foreground">bearing:</span>{" "}
        {viewport.bearing.toFixed(1)}°
      </span>
      <span>
        <span className="text-muted-foreground">pitch:</span>{" "}
        {viewport.pitch.toFixed(1)}°
      </span>
    </div>
  );
}

export default function ConvoyMap() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [convoy, setConvoy] = useState<Convoy | null>(null);
  const [members, setMembers] = useState<MemberWithProfile[]>([]);
  const [locations, setLocations] = useState<MemberLocation[]>([]);
  const [locationClock, setLocationClock] = useState(() => Date.now());
  const [showMembers, setShowMembers] = useState(false);
  const [routeSearch, setRouteSearch] = useState<RouteSearch | null>(null);
  const [previewedRoute, setPreviewedRoute] = useState<RouteOption | null>(null);
  const [storedRoute, setStoredRoute] = useState<Tables<"convoy_routes"> | null>(null);
  const [viaPin, setViaPin] = useState<{ point: Coordinate; destination: Coordinate } | null>(null);
  const [sharingRoute, setSharingRoute] = useState(false);
  const [showRouteChoices, setShowRouteChoices] = useState(true);
  const [isLoadingRoutes, setIsLoadingRoutes] = useState(false);
  const [routeOrigin, setRouteOrigin] = useState<Coordinate | null>(null);
  const [originMode, setOriginMode] = useState<"live" | "manual">("live");
  const [originInput, setOriginInput] = useState(LIVE_ORIGIN_LABEL);
  const [manualOrigin, setManualOrigin] = useState<NamedCoordinate | null>(null);
  const [destination, setDestination] = useState<NamedCoordinate | null>(null);
  const [destinationDraft, setDestinationDraft] = useState<string | null>(null);
  const [selectedDestination, setSelectedDestination] = useState<NamedCoordinate | null>(null);
  const [applyingRoute, setApplyingRoute] = useState(false);
  const [pinTarget, setPinTarget] = useState<"from" | "to" | "via" | null>(null);
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const [plannerMinimized, setPlannerMinimized] = useState(false);
  const [switchToLive, setSwitchToLive] = useState(false);
  const [viewport, setViewport] = useState<MapViewport>(DEFAULT_VIEWPORT);
  const [mapInstance, setMapInstance] = useState<MapRef | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [cameraMode, setCameraMode] = useState<"overview" | "free" | "follow">("overview");
  const [mapViewMode, setMapViewMode] = useState<"members" | "speed">("members");
  const [dismissedGapAlertUserId, setDismissedGapAlertUserId] = useState<string | null>(null);
  const [selectedSpeedUserId, setSelectedSpeedUserId] = useState<string | null>(null);
  const quickDestinationSuggestions = useMemo(() => getQuickDestinationSuggestions(6), []);
  const {
    fix: myLocation, stale, attempt: retryCount, permission: locationPermissionState,
    error: gpsError, environmentError, phase: locationPhase, retry: retryLocation,
  } = useConvoyPosition(Boolean(id && user));
  const liveFix = stale || !isRoutingFix(myLocation) ? null : myLocation;
  const gpsOutline = useMemo(() => myLocation ? accuracyOutline(myLocation) : [], [myLocation]);
  const destInput = destinationDraft ?? destination?.name ?? convoy?.destination_address ?? "";
  const { suggestions: originSuggestions, searching: searchingOrigin, failed: originSearchFailed } =
    useConvoyPlaceSearch(originInput, originMode === "manual" && !manualOrigin && !pinTarget);
  const { suggestions: destSuggestions, searching: searchingDest, failed: destinationSearchFailed } =
    useConvoyPlaceSearch(destInput, !selectedDestination && destinationDraft !== null && !pinTarget);

  const hasCenteredOnUserRef = useRef(false);
  const initialFrameRef = useRef<"destination" | "route" | null>(null);
  const localDestinationRef = useRef(false);
  const convoyRequestRef = useRef(0);
  const sharedRouteRequestRef = useRef(0);
  const isLeader = Boolean(user && convoy?.leader_id === user.id);
  const via = viaPin && sameRoutePoint(viaPin.destination, destination) ? viaPin.point : null;

  const sharedRoute = useMemo(() => {
    if (!destination || !storedRoute || storedRoute.convoy_id !== id
      || storedRoute.shared_by !== convoy?.leader_id
      || storedRoute.destination_lat !== destination.lat || storedRoute.destination_lng !== destination.lng) return null;
    return parseDrivingRoute(storedRoute.route);
  }, [convoy?.leader_id, destination, id, storedRoute]);
  const showSharedOnly = Boolean(sharedRoute && !isLeader);

  const currentSearch = routeSearch && sameRoutePoint(routeSearch.origin, routeOrigin)
    && sameRoutePoint(routeSearch.destination, destination) && sameRoutePoint(routeSearch.via, via)
    ? routeSearch : null;
  const routeError = showSharedOnly ? null : currentSearch?.message;
  const routeChoices = useMemo(() => {
    const options = sharedRoute && !isLeader ? [] : currentSearch?.options ?? [];
    const choices = options.filter(({ route }) => !sameRoute(route, sharedRoute) && (!sharedRoute || route.mode !== "direct"));
    const fastest = options.reduce<RouteOption | null>((best, { route }) => route.mode === "routed"
      && (!best || route.duration < best.duration) ? route : best, null);
    return [
      ...(sharedRoute ? [{ id: "shared", route: sharedRoute, shared: true, label: "Convoy route", color: SHARED_ROUTE_COLOR,
        fastest: sameRoute(sharedRoute, fastest) }] : []),
      ...choices.map(({ route, via: viaRoad }, index) => ({
        id: `option-${index}`, route, shared: false, color: ROUTE_COLORS[index % ROUTE_COLORS.length],
        label: viaRoad ? "Via pinned road" : route.mode === "direct" ? "Straight-line distance" : `Route ${index + 1}`,
        fastest: route === fastest,
      })),
    ];
  }, [currentSearch, isLeader, sharedRoute]);

  const selectedChoice = routeChoices.find(({ route }) => route === previewedRoute) ?? routeChoices[0];
  const selectedRoute = selectedChoice?.route ?? null;
  const routeInfo = selectedRoute
    ? {
        distanceKm: selectedRoute.distance / 1000,
        durationMin: selectedRoute.mode === "routed" ? selectedRoute.duration / 60 : null,
      }
    : null;
  const routeOriginLabel = originMode === "live" ? liveFix ? "My location" : "Starting point needed"
    : manualOrigin?.name || originInput.trim() || "Custom start";
  const routeDestinationLabel = destination?.name || "No destination";
  const awaitingPermission = locationPhase === "requesting" && locationPermissionState !== "granted";
  const needsPermission = locationPhase === "idle" && locationPermissionState !== "granted";
  const locationLoading = locationPhase === "requesting" || locationPhase === "locating" || locationPhase === "retrying";
  const locationError = environmentError
    ?? (locationPhase === "unavailable" && locationPermissionState !== "granted"
      ? "The browser did not return a location. Check for a permission prompt or try opening Convoy in Chrome or Safari."
      : gpsError === null ? null : getGeolocationErrorMessage({ code: gpsError }, "tracking", locationPhase === "retrying"));
  const locationStatusMessage = liveFix ? "Location locked"
    : locationPermissionState === "denied" ? "Location access needed"
    : environmentError ? "Location unavailable"
    : awaitingPermission ? "Waiting for location permission"
    : locationPhase === "unavailable" ? stale ? "Last known location" : "No location fix yet"
    : locationPhase === "retrying" ? "Reconnecting to location..."
    : needsPermission ? "Location access needed"
    : stale ? "Last known location"
    : myLocation ? "Improving accuracy..."
    : "Getting precise location...";
  const liveOriginWaitingMessage = locationError
    ? `${locationError} You can also pin a starting point.`
    : needsPermission ? "Enable location or choose a starting point."
      : "Waiting for a location accurate to 50 m or better. You can also choose or pin a starting point.";
  const locationCoordinatesLabel = myLocation
    ? `Lat ${myLocation.lat.toFixed(5)}, Lng ${myLocation.lng.toFixed(5)} · Accuracy ±${Math.round(myLocation.accuracy)} m`
    : null;
  const locationSourceLabel = stale ? "Last known" : liveFix ? "Device location" : myLocation ? "Low accuracy" : null;
  const locationHint = liveFix || environmentError ? null
    : locationPermissionState === "denied" ? "Allow location for this site in your browser settings, then retry."
    : awaitingPermission ? "Choose Allow if the browser asks to use your location."
    : needsPermission ? "Enable location to use your current position."
    : manualOrigin ? "Your route from the selected starting point is still available."
    : null;

  const speedClusterData = useMemo(() => {
    const features = locations
      .flatMap((location) => {
        const member = members.find((currentMember) => currentMember.user_id === location.user_id);
        if (!member) return [];

        return [{
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: [location.lng, location.lat] as [number, number],
          },
          properties: {
            userId: location.user_id,
            name: member.profiles?.display_name || "Unknown",
            speedLabel: formatLiveSpeed(location.speed, isMemberLocationStale(location.updated_at, locationClock)),
            role: member.role,
            updatedAt: location.updated_at,
          },
        }];
      });

    return {
      type: "FeatureCollection" as const,
      features,
    };
  }, [locationClock, locations, members]);
  const selectedSpeedPoint = speedClusterData.features.find((point) => point.properties.userId === selectedSpeedUserId);

  useEffect(() => {
    let nextExpiry = Infinity;
    for (const location of locations) {
      const deadline = Date.parse(location.updated_at) + POSITION_MAX_AGE_MS;
      if (deadline > locationClock) nextExpiry = Math.min(nextExpiry, deadline);
    }
    if (!Number.isFinite(nextExpiry)) return;

    const timer = window.setTimeout(
      () => setLocationClock(Math.max(nextExpiry, Date.now())),
      Math.max(0, nextExpiry - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [locationClock, locations]);

  const gapAlert = useMemo<GapAlert | null>(() => {
    if (!destination || locations.length < 2) return null;

    const memberDistances = locations
      .map((location) => {
        const member = members.find((currentMember) => currentMember.user_id === location.user_id);
        if (!member || isMemberLocationStale(location.updated_at, locationClock)) return null;

        return {
          userId: location.user_id,
          name: member.profiles?.display_name || "Unknown",
          role: member.role,
          coordinates: [location.lng, location.lat] as RouteCoordinate,
          remainingDistance: haversineMeters(
            { lat: location.lat, lng: location.lng },
            destination,
          ),
        };
      })
      .filter(Boolean) as Array<{
      userId: string;
      name: string;
      role: string;
      coordinates: RouteCoordinate;
      remainingDistance: number;
    }>;

    if (memberDistances.length < 2) return null;

    const leaderDistance =
      memberDistances.find(
        (member) => member.userId === convoy?.leader_id || member.role === "leader",
      ) ?? memberDistances.reduce((closest, member) =>
        member.remainingDistance < closest.remainingDistance ? member : closest,
      );

    const behindMembers = memberDistances
      .filter((member) => member.userId !== leaderDistance.userId)
      .map((member) => ({
        ...member,
        gapMeters: member.remainingDistance - leaderDistance.remainingDistance,
      }))
      .filter((member) => member.gapMeters >= 2000)
      .sort((a, b) => b.gapMeters - a.gapMeters);

    if (behindMembers.length === 0) return null;

    const worstGap = behindMembers[0];
    return {
      userId: worstGap.userId,
      name: worstGap.name,
      coordinates: worstGap.coordinates,
      gapMeters: worstGap.gapMeters,
    };
  }, [convoy?.leader_id, destination, locationClock, locations, members]);

  const activeGapAlert =
    gapAlert && dismissedGapAlertUserId !== gapAlert.userId ? gapAlert : null;

  useEffect(() => {
    if (!gapAlert) {
      setDismissedGapAlertUserId(null);
    }
  }, [gapAlert]);

  useEffect(() => {
    if (mapViewMode !== "speed") {
      setSelectedSpeedUserId(null);
    }
  }, [mapViewMode]);

  useEffect(() => {
    if (!mapInstance) {
      setMapReady(false);
      return;
    }

    if (mapInstance.loaded()) {
      setMapReady(true);
      return;
    }

    const handleLoad = () => setMapReady(true);
    mapInstance.on("load", handleLoad);

    return () => {
      mapInstance.off("load", handleLoad);
      setMapReady(false);
    };
  }, [mapInstance]);

  useEffect(() => {
    if (!id || !user) return;

    void loadConvoy();
    void loadMembers();
    void loadLocations();
    void loadSharedRoute();
    const channel = supabase
      .channel(`convoy-map-${id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "member_locations", filter: `convoy_id=eq.${id}` },
        () => void loadLocations(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "convoys", filter: `id=eq.${id}` },
        () => {
          void loadConvoy();
          void loadSharedRoute();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "convoy_alerts", filter: `convoy_id=eq.${id}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const alert = payload.new as { message?: string; type?: string };
            toast.warning(alert.message || `Alert: ${alert.type}`, { duration: 5000 });
          }
        },
      )
      .subscribe();
    const routeChannel = supabase
      .channel(`convoy-shared-route-${id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "convoy_routes", filter: `convoy_id=eq.${id}` },
        () => void loadSharedRoute(),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void loadSharedRoute();
      });

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(routeChannel);
      convoyRequestRef.current += 1;
      sharedRouteRequestRef.current += 1;
    };
  }, [id, user]);

  const handleMapRef = useCallback((instance: MapRef | null) => {
    setMapInstance((current) => (current === instance ? current : instance));
  }, []);

  const loadConvoy = async () => {
    const request = ++convoyRequestRef.current;
    const { data, error } = await supabase.from("convoys").select("*").eq("id", id!).single();
    if (request !== convoyRequestRef.current) return;
    if (error) {
      toast.error(error.message || "Failed to load convoy");
      return;
    }

    setConvoy(data);
    if (localDestinationRef.current) return;
    const { destination_address: name, destination_lat: lat, destination_lng: lng } = data;
    const saved = name && lat !== null && lng !== null && isValidCoordinate(lat, lng)
      ? { name, lat, lng }
      : null;
    setDestination((previous) => previous?.name === saved?.name
      && previous?.lat === saved?.lat && previous?.lng === saved?.lng ? previous : saved);
  };

  const loadSharedRoute = async () => {
    const request = ++sharedRouteRequestRef.current;
    const { data, error } = await supabase.from("convoy_routes").select("*").eq("convoy_id", id!).maybeSingle();
    if (!error && request === sharedRouteRequestRef.current) setStoredRoute(data);
  };

  useEffect(() => {
    if (isLeader || !convoy?.destination_address || !storedRoute || storedRoute.convoy_id !== id
      || storedRoute.shared_by !== convoy.leader_id || storedRoute.destination_lat !== convoy.destination_lat
      || storedRoute.destination_lng !== convoy.destination_lng) return;

    localDestinationRef.current = false;
    const target = { name: convoy.destination_address, lat: storedRoute.destination_lat, lng: storedRoute.destination_lng };
    setDestination((previous) => previous?.name === target.name && sameRoutePoint(previous, target) ? previous : target);
  }, [convoy, id, isLeader, storedRoute]);

  const loadMembers = async () => {
    const { data } = await supabase.from("convoy_members").select("*").eq("convoy_id", id!);
    if (!data || data.length === 0) {
      setMembers([]);
      return;
    }

    const userIds = data.map((member) => member.user_id);
    const { data: profiles } = await supabase.from("profiles").select("*").in("user_id", userIds);
    const profileById = new Map(profiles?.map((profile) => [profile.user_id, profile]) || []);
    const withProfiles = data.map((member) => ({
      ...member,
      profiles: profileById.get(member.user_id) || null,
    }));
    setMembers(withProfiles as MemberWithProfile[]);
  };

  const loadLocations = async () => {
    const { data } = await supabase.from("member_locations").select("*").eq("convoy_id", id!);
    if (!data) return;

    setLocationClock(Date.now());
    setLocations(data);
  };

  const userId = user?.id;
  const latestFix = useRef(liveFix);
  latestFix.current = liveFix;

  useEffect(() => {
    if (!id || !userId) return;
    let lastPublished = 0;
    let saving = false;
    const controller = new AbortController();

    const publish = async () => {
      const fix = latestFix.current;
      if (saving || !isRoutingFix(fix) || fix.timestamp <= lastPublished || document.hidden) return;
      saving = true;
      try {
        const { error } = await supabase.from("member_locations").upsert({
          convoy_id: id,
          user_id: userId,
          lat: fix.lat,
          lng: fix.lng,
          heading: fix.heading ?? 0,
          speed: fix.speed,
        }, { onConflict: "convoy_id,user_id" }).abortSignal(controller.signal);
        if (error) throw error;
        lastPublished = fix.timestamp;
      } catch (error) {
        if (!controller.signal.aborted) console.warn("Failed to sync member location:", error);
      } finally {
        saving = false;
      }
    };

    const interval = window.setInterval(() => void publish(), 3000);
    return () => {
      clearInterval(interval);
      controller.abort();
    };
  }, [id, userId]);

  useEffect(() => {
    if (!mapInstance) return;

    const pauseCamera = ({ originalEvent }: { originalEvent?: Event }) => {
      if (originalEvent) setCameraMode("free");
    };
    mapInstance.on("movestart", pauseCamera);
    mapInstance.on("dragstart", pauseCamera);
    mapInstance.on("zoomstart", pauseCamera);
    return () => {
      mapInstance.off("movestart", pauseCamera);
      mapInstance.off("dragstart", pauseCamera);
      mapInstance.off("zoomstart", pauseCamera);
    };
  }, [mapInstance]);

  const centerOnFix = useCallback((fix: Coordinate) => {
    if (!mapInstance) return;
    mapInstance.easeTo({ center: [fix.lng, fix.lat], zoom: Math.max(mapInstance.getZoom(), 15), duration: 800 });
  }, [mapInstance]);

  useEffect(() => {
    if (!mapInstance || !mapReady || !liveFix || pinTarget) return;

    if (cameraMode === "follow") {
      const follow = () => {
        if (haversineMeters(mapInstance.getCenter(), liveFix) < FOLLOW_THRESHOLD_METERS) return;
        mapInstance.easeTo({ center: [liveFix.lng, liveFix.lat], duration: 450 });
      };
      if (!mapInstance.isMoving()) {
        follow();
        return;
      }
      // Apply a fix that arrived during a camera animation as soon as it finishes.
      const handleMoveEnd = ({ originalEvent }: { originalEvent?: Event }) => {
        if (!originalEvent) follow();
      };
      mapInstance.once("moveend", handleMoveEnd);
      return () => { mapInstance.off("moveend", handleMoveEnd); };
    }

    if (cameraMode === "overview" && !hasCenteredOnUserRef.current && !manualOrigin && !destination) {
      hasCenteredOnUserRef.current = true;
      centerOnFix(liveFix);
    }
  }, [cameraMode, centerOnFix, destination, liveFix, manualOrigin, mapInstance, mapReady, pinTarget]);

  const handleRetryLocationAccess = () => {
    if (!liveFix) {
      retryLocation.current();
    } else if (cameraMode === "follow") {
      setCameraMode("free");
    } else {
      setCameraMode("follow");
      centerOnFix(liveFix);
    }
  };

  const focusRouteIn3D = (origin: Coordinate | null, target: Coordinate | null, follow = false) => {
    if (!origin || !mapInstance) return;
    setCameraMode(follow ? "follow" : "free");
    mapInstance.easeTo({
      center: [origin.lng, origin.lat],
      zoom: Math.max(mapInstance.getZoom(), target ? 16 : 15),
      pitch: 60,
      bearing: target ? getBearingDegrees(origin, target) : mapInstance.getBearing(),
      duration: 1200,
    });
  };

  const getMemberColor = (role: string) => {
    switch (role) {
      case "leader":
        return "hsl(var(--convoy-leader))";
      case "sweep":
        return "hsl(var(--convoy-sweep))";
      default:
        return "hsl(var(--convoy-follower))";
    }
  };

  const getMemberForLocation = (location: MemberLocation) =>
    members.find((member) => member.user_id === location.user_id);

  const getMemberPinLabel = (member: MemberWithProfile) =>
    member.profiles?.display_name?.trim().charAt(0).toUpperCase() || member.role.charAt(0).toUpperCase();

  const plannedOrigin = originMode === "manual" ? manualOrigin : liveFix;
  useEffect(() => {
    setRouteOrigin((previous) => {
      if (!plannedOrigin || originMode === "manual" || !previous) return plannedOrigin;
      const distance = haversineMeters(previous, plannedOrigin);
      return distance >= REROUTE_THRESHOLD_METERS ? plannedOrigin : previous;
    });
  }, [originMode, plannedOrigin]);

  useEffect(() => {
    setPreviewedRoute(null);
    if (!destination || !routeOrigin || showSharedOnly) {
      setIsLoadingRoutes(false);
      return;
    }

    const controller = new AbortController();
    setIsLoadingRoutes(true);
    void Promise.all([
      fetchDrivingRoutes(routeOrigin, destination, controller.signal, true),
      via ? fetchDrivingRoutes(routeOrigin, destination, controller.signal, false, via) : null,
    ]).then(([{ routes, message }, viaResult]) => {
      if (controller.signal.aborted) return;
      const options = routes.map((route) => ({ route, via: false }));
      const viaRoute = viaResult?.routes[0];
      let viaMessage = viaResult?.message ?? null;
      if (viaRoute) {
        if (routes.some((route) => sameRoute(route, viaRoute))) {
          viaMessage = "That pin follows a suggested route. Try a different road.";
        } else {
          options.push({ route: viaRoute, via: true });
        }
      }
      if (!options.length) {
        options.push({ route: {
          coordinates: [[routeOrigin.lng, routeOrigin.lat], [destination.lng, destination.lat]],
          distance: haversineMeters(routeOrigin, destination),
          duration: 0,
          mode: "direct",
        }, via: false });
      }
      setRouteSearch({
        origin: routeOrigin,
        destination,
        via,
        options,
        message: options[0].route.mode === "direct" ? `${message ?? "Driving directions are unavailable."} Showing straight-line distance.` : routes.length ? message : null,
        viaMessage,
      });
      setIsLoadingRoutes(false);
    });
    return () => controller.abort();
  }, [destination, routeOrigin, showSharedOnly, via]);

  const handleSelectOrigin = useCallback((suggestion: DestinationSuggestion) => {
    const { lat, lon, display_name: name } = suggestion;
    if (lat === undefined || lon === undefined || !isValidCoordinate(lat, lon)) return;
    setOriginMode("manual");
    setOriginInput(name);
    setManualOrigin({ name, lat, lng: lon });
    setSwitchToLive(false);
    setPlannerError(null);
  }, []);

  const handleSelectDestination = useCallback((suggestion: DestinationSuggestion) => {
    const { lat, lon, display_name: name } = suggestion;
    if (lat === undefined || lon === undefined || !isValidCoordinate(lat, lon)) return;
    setDestinationDraft(name);
    setSelectedDestination({ name, lat, lng: lon });
    setPlannerError(null);
  }, []);

  const handlePickPin = (target: "from" | "to" | "via") => {
    if (target === "from") setSwitchToLive(false);
    setPinTarget(target);
    setPlannerError(null);
    setCameraMode("free");
  };

  useEffect(() => {
    if (!mapInstance || !pinTarget) return;
    const canvas = mapInstance.getCanvas();
    const previousCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    const handleClick = ({ lngLat }: { lngLat: { lat: number; lng: number } }) => {
      const lng = ((lngLat.lng + 180) % 360 + 360) % 360 - 180;
      const coordinate = coordinateSuggestion(lngLat.lat, lng);
      if (pinTarget === "from") handleSelectOrigin(coordinate);
      else if (pinTarget === "to") handleSelectDestination(coordinate);
      else if (destination) setViaPin({ point: { lat: lngLat.lat, lng }, destination });
      setPinTarget(null);
    };
    mapInstance.on("click", handleClick);
    return () => {
      canvas.style.cursor = previousCursor;
      mapInstance.off("click", handleClick);
    };
  }, [destination, handleSelectDestination, handleSelectOrigin, mapInstance, pinTarget]);

  const handleOriginInputChange = (value: string) => {
    setSwitchToLive(false);
    setCameraMode("free");
    setOriginMode("manual");
    setOriginInput(value);
    setManualOrigin(null);
    setPlannerError(null);
  };

  const applyLiveOrigin = useCallback((fix: Coordinate) => {
    setSwitchToLive(false);
    setOriginMode("live");
    setOriginInput(LIVE_ORIGIN_LABEL);
    setManualOrigin(null);
    setPinTarget(null);
    setPlannerError(null);
    setRouteOrigin(fix);
    setCameraMode("follow");
    centerOnFix(fix);
  }, [centerOnFix]);

  useEffect(() => {
    if (switchToLive && liveFix) applyLiveOrigin(liveFix);
  }, [applyLiveOrigin, liveFix, switchToLive]);

  const handleUseLiveOrigin = () => {
    if (liveFix) {
      applyLiveOrigin(liveFix);
      return;
    }
    if (!environmentError) {
      setSwitchToLive(true);
      retryLocation.current();
    }
  };

  const handleApplyRouteSearch = async () => {
    const inputOrigin = originMode === "manual" ? parseCoordinateSuggestion(originInput) : null;
    const origin = originMode === "live" ? (isRoutingFix(liveFix) ? liveFix : null)
      : manualOrigin ?? (inputOrigin ? { lat: inputOrigin.lat, lng: inputOrigin.lon } : null);
    const inputDestination = parseCoordinateSuggestion(destInput);
    const target = selectedDestination ?? (destinationDraft === null ? destination : null)
      ?? (inputDestination ? { name: inputDestination.display_name, lat: inputDestination.lat, lng: inputDestination.lon } : null);

    if (!origin || !target) {
      setPlannerError(!origin
        ? originMode === "live" ? liveOriginWaitingMessage : "Choose a starting point from the results or pin it on the map."
        : "Choose a destination from the results or pin it on the map.");
      return;
    }

    if (isLeader && target !== destination) {
      setApplyingRoute(true);
      try {
        const { data, error } = await supabase.from("convoys").update({
          destination_address: target.name,
          destination_lat: target.lat,
          destination_lng: target.lng,
        }).eq("id", id!).select("*").single();
        if (error || !data) throw error ?? new Error("Destination update was not applied");
        convoyRequestRef.current += 1;
        setConvoy(data);
        setViaPin(null);
        void loadSharedRoute();
      } catch {
        setPlannerError("The convoy destination could not be saved. Try again.");
        return;
      } finally {
        setApplyingRoute(false);
      }
    } else if (target !== destination) {
      localDestinationRef.current = true;
    }

    if (inputOrigin && !manualOrigin) handleSelectOrigin(inputOrigin);
    setDestination(target);
    setDestinationDraft(null);
    setSelectedDestination(null);
    setPlannerError(null);
    const currentOrigin = originMode === "live"
      ? isRoutingFix(latestFix.current) ? latestFix.current : null
      : origin;
    setRouteOrigin(currentOrigin);
    if (!currentOrigin) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    focusRouteIn3D(currentOrigin, target, originMode === "live");
    setPlannerMinimized(true);
  };

  const getRouteBoundsPoints = useCallback((route: RouteOption | null): RouteCoordinate[] => {
    if (route?.mode === "routed") return route.coordinates;
    if (!destination) return [];
    const endpoints: RouteCoordinate[] = [[destination.lng, destination.lat]];
    if (routeOrigin) endpoints.unshift([routeOrigin.lng, routeOrigin.lat]);
    return route ? [...endpoints, ...route.coordinates] : endpoints;
  }, [destination, routeOrigin]);

  const showRouteOverview = useCallback((points: RouteCoordinate[]) => {
    if (!mapInstance || points.length === 0) return;

    if (points.length === 1) {
      mapInstance.easeTo({
        center: points[0],
        zoom: 14,
        bearing: 0,
        pitch: 0,
        duration: 700,
      });
      return;
    }

    const bounds = points.reduce(
      (currentBounds, coordinate) => currentBounds.extend(coordinate),
      new LngLatBounds(),
    );
    mapInstance.fitBounds(bounds, {
      duration: 900,
      maxZoom: 15,
      bearing: 0,
      pitch: 0,
      padding: { top: 140, right: 45, bottom: 90, left: 45 },
    });
  }, [mapInstance]);

  useEffect(() => {
    if (!mapReady || cameraMode !== "overview" || pinTarget || !destination) return;
    if (initialFrameRef.current === "route" || (routeOrigin && !selectedRoute)) return;

    const frame = selectedRoute ? "route" : "destination";
    if (initialFrameRef.current === frame) return;
    initialFrameRef.current = frame;
    showRouteOverview(getRouteBoundsPoints(selectedRoute));
  }, [cameraMode, destination, getRouteBoundsPoints, mapReady, pinTarget, routeOrigin, selectedRoute, showRouteOverview]);

  const handleSelectRoute = useCallback((route: RouteOption) => {
    setCameraMode("free");
    setPreviewedRoute(route);
    showRouteOverview(getRouteBoundsPoints(route));
  }, [getRouteBoundsPoints, showRouteOverview]);

  useEffect(() => {
    if (!mapInstance || pinTarget || !routeChoices.length) return;
    const handleClick = ({ point }: { point: { x: number; y: number } }) => {
      const layers = routeChoices.map(({ id }) => `route-layer-${id}`).filter((layer) => mapInstance.getLayer(layer));
      if (!layers.length) return;
      const [feature] = mapInstance.queryRenderedFeatures([point.x, point.y], { layers });
      const choice = routeChoices.find(({ id }) => `route-layer-${id}` === feature?.layer.id);
      if (choice) handleSelectRoute(choice.route);
    };
    mapInstance.on("click", handleClick);
    return () => { mapInstance.off("click", handleClick); };
  }, [handleSelectRoute, mapInstance, pinTarget, routeChoices]);

  const canShareSelectedRoute = isLeader && Boolean(id && user && destination && currentSearch
    && selectedChoice && selectedRoute?.mode === "routed" && !selectedChoice.shared
    && !isLoadingRoutes && convoy?.destination_lat === destination.lat && convoy?.destination_lng === destination.lng);

  const handleShareRoute = async () => {
    if (!canShareSelectedRoute || !id || !user || !destination || !selectedRoute || sharingRoute) return;
    setSharingRoute(true);
    try {
      const { coordinates, duration, distance } = selectedRoute;
      const { error } = await supabase.from("convoy_routes").upsert({
        convoy_id: id,
        destination_lat: destination.lat,
        destination_lng: destination.lng,
        route: { coordinates, duration, distance },
        shared_by: user.id,
      });
      if (error) throw error;
      await loadSharedRoute();
      toast.success("Route shared with the convoy.");
    } catch (error) {
      console.warn("Could not share convoy route:", error);
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      toast.error(code === "PGRST205" || code === "42P01"
        ? "Route sharing isn't set up on this server yet. You can still preview routes."
        : "Couldn't share this route. Check the connection and destination, then try again.");
    } finally {
      setSharingRoute(false);
    }
  };

  const visibleDestination = selectedDestination ?? destination;
  const handle3DView = () => focusRouteIn3D(plannedOrigin, visibleDestination, originMode === "live");

  const handleResetView = () => {
    setCameraMode("free");
    const points = getRouteBoundsPoints(selectedRoute);
    if (points.length) showRouteOverview(points);
    else mapInstance?.easeTo({ pitch: 0, bearing: 0, duration: 700 });
  };

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="z-20 shrink-0 border-b border-border/80 bg-card/80 backdrop-blur-sm">
        <div className="flex h-14 items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate(`/convoy/${id}`)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-bold">{convoy?.name || "Convoy"}</p>
              {destination?.name ? (
                <p className="max-w-[220px] truncate text-xs text-muted-foreground">
                  → {destination.name}
                </p>
              ) : locationError || locationLoading || !liveFix ? (
                <p
                  className={`max-w-[220px] truncate text-[11px] ${
                    locationError ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  {locationStatusMessage}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Live convoy view</p>
              )}
            </div>
          </div>

          <Button
            variant={showMembers ? "secondary" : "outline"}
            size="sm"
            onClick={() => setShowMembers((current) => !current)}
            className="gap-2 shrink-0"
          >
            <Users className="h-4 w-4" />
            {showMembers ? "Hide Members" : "Members"}
          </Button>
        </div>
        <div className="flex items-center gap-2 border-t border-border/70 px-4 py-2">
          <Button
            variant={mapViewMode === "members" ? "secondary" : "outline"}
            size="sm"
            onClick={() => setMapViewMode("members")}
          >
            Members View
          </Button>
          <Button
            variant={mapViewMode === "speed" ? "secondary" : "outline"}
            size="sm"
            onClick={() => setMapViewMode("speed")}
          >
            Speed Clusters
          </Button>
        </div>
      </header>

      <div className="relative flex-1 bg-muted">
        <AppMap
          ref={handleMapRef}
          className={pinTarget
            ? "absolute inset-0 [&_.maplibregl-marker]:pointer-events-none [&_.maplibregl-popup]:pointer-events-none"
            : "absolute inset-0"}
          center={DEFAULT_VIEWPORT.center}
          zoom={DEFAULT_VIEWPORT.zoom}
          onViewportChange={setViewport}
          maxPitch={60}
        >
          {myLocation && <MapRoute coordinates={gpsOutline} color={liveFix ? "#3b82f6" : "#64748b"} width={2} opacity={0.55} interactive={false} />}
          {[...routeChoices.filter((choice) => choice !== selectedChoice), ...(selectedChoice ? [selectedChoice] : [])].map(({ route, id, color, shared }) => {
            const isSelected = route === selectedRoute;
            const isDirect = route.mode === "direct";

            return (
              <MapRoute
                key={`${id}-${route.mode}-${isSelected}`}
                id={id}
                coordinates={route.coordinates}
                color={isDirect ? "#fbbf24" : color}
                width={isSelected ? 7 : shared ? 6 : 4}
                opacity={isSelected || shared ? 1 : 0.7}
                dashArray={isDirect ? [2, 2] : undefined}
                interactive={!pinTarget}
              />
            );
          })}

          {via && (
            <MapMarker longitude={via.lng} latitude={via.lat}>
              <MarkerContent>
                <ConvoyMarkerPin color="#0ea5e9" label="V" />
              </MarkerContent>
            </MapMarker>
          )}

          {mapViewMode === "members" &&
            locations.map((location) => {
              const member = getMemberForLocation(location);
              if (!member || location.user_id === userId) return null;

              const stale = isMemberLocationStale(location.updated_at, locationClock);
              return (
                <MapMarker
                  key={location.id}
                  longitude={location.lng}
                  latitude={location.lat}
                  anchor="bottom"
                >
                  <MarkerContent>
                    <MemberSpeedLabel speed={location.speed} stale={stale} />
                    <ConvoyMarkerPin
                      color={getMemberColor(member.role)}
                      label={getMemberPinLabel(member)}
                      stale={stale}
                    />
                  </MarkerContent>
                  <MarkerPopup className="min-w-[180px]">
                    <div className="space-y-1">
                      <p className="font-semibold">{member.profiles?.display_name || "Unknown"}</p>
                      <p className="text-xs capitalize text-muted-foreground">Role: {member.role}</p>
                      <p className="text-xs text-muted-foreground">
                        Speed: {formatLiveSpeed(location.speed, stale)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Updated: {new Date(location.updated_at).toLocaleTimeString()}
                      </p>
                      {stale && (
                        <p className="text-xs text-destructive">Location update is stale</p>
                      )}
                    </div>
                  </MarkerPopup>
                </MapMarker>
              );
            })}

          {mapViewMode === "members" && myLocation && (
            <MapMarker longitude={myLocation.lng} latitude={myLocation.lat} anchor="center">
              <MarkerContent>
                <MemberSpeedLabel speed={liveFix?.speed ?? null} stale={stale} />
                <CurrentLocationMarker heading={myLocation.heading} precise={Boolean(liveFix)} />
              </MarkerContent>
              <MarkerPopup className="min-w-[170px]">
                <div className="space-y-1">
                  <p className="font-semibold">{stale ? "Last known location" : liveFix ? "Your location" : "Low-accuracy location"}</p>
                  <p className="text-xs text-muted-foreground">
                    {myLocation.lat.toFixed(6)}, {myLocation.lng.toFixed(6)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Accuracy: ±{Math.round(myLocation.accuracy)} m
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Speed: {formatLiveSpeed(liveFix?.speed ?? null, stale)}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    Fix time: {new Date(myLocation.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              </MarkerPopup>
            </MapMarker>
          )}

          {mapViewMode === "speed" && speedClusterData.features.length > 0 && (
            <MapClusterLayer<SpeedPointProperties>
              data={speedClusterData}
              clusterRadius={50}
              clusterMaxZoom={14}
              clusterColors={["#1d8cf8", "#6d5dfc", "#e23670"]}
              pointColor="#1d8cf8"
              pointLabelProperty="speedLabel"
              onPointClick={(feature) => setSelectedSpeedUserId(feature.properties.userId)}
            />
          )}

          {mapViewMode === "speed" && selectedSpeedPoint && (
            <MapPopup
              key={selectedSpeedPoint.properties.userId}
              longitude={selectedSpeedPoint.geometry.coordinates[0]}
              latitude={selectedSpeedPoint.geometry.coordinates[1]}
              onClose={() => setSelectedSpeedUserId(null)}
              closeOnClick={false}
              focusAfterOpen={false}
              closeButton
            >
              <div className="space-y-1 p-1">
                <p className="text-sm font-semibold">{selectedSpeedPoint.properties.name}</p>
                <p className="text-sm">Speed: {selectedSpeedPoint.properties.speedLabel}</p>
                <p className="text-xs capitalize text-muted-foreground">
                  Role: {selectedSpeedPoint.properties.role}
                </p>
                <p className="text-xs text-muted-foreground">
                  Updated: {new Date(selectedSpeedPoint.properties.updatedAt).toLocaleTimeString()}
                </p>
              </div>
            </MapPopup>
          )}

          {activeGapAlert && (
            <MapPopup
              key={`gap-alert-${activeGapAlert.userId}`}
              longitude={activeGapAlert.coordinates[0]}
              latitude={activeGapAlert.coordinates[1]}
              onClose={() => setDismissedGapAlertUserId(activeGapAlert.userId)}
              closeOnClick={false}
              focusAfterOpen={false}
              closeButton
              className="w-72"
            >
              <div className="space-y-2">
                <p className="font-semibold text-foreground">Gap Alert</p>
                <p className="text-sm text-muted-foreground">
                  {activeGapAlert.name} is behind by {formatDistance(activeGapAlert.gapMeters)}.
                </p>
              </div>
            </MapPopup>
          )}

          {visibleDestination && (
            <MapMarker longitude={visibleDestination.lng} latitude={visibleDestination.lat} anchor="bottom">
              <MarkerContent>
                <DestinationMarker />
              </MarkerContent>
              <MarkerPopup className="min-w-[200px]">
                <div className="space-y-1">
                  <p className="font-semibold">{selectedDestination ? "Selected destination" : "Destination"}</p>
                  <p className="text-sm text-foreground/80">{visibleDestination.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {visibleDestination.lat.toFixed(6)}, {visibleDestination.lng.toFixed(6)}
                  </p>
                </div>
              </MarkerPopup>
            </MapMarker>
          )}

          {originMode === "manual" && manualOrigin && (
            <MapMarker longitude={manualOrigin.lng} latitude={manualOrigin.lat} anchor="bottom">
              <MarkerContent>
                <div className="relative">
                  <ConvoyMarkerPin color="hsl(var(--primary))" label="S" />
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 rounded-full border bg-background/90 px-2 py-1 text-[10px] font-semibold shadow-sm">
                    Start
                  </div>
                </div>
              </MarkerContent>
              <MarkerPopup className="min-w-[200px]">
                <div className="space-y-1">
                  <p className="font-semibold">Starting point</p>
                  <p className="text-xs text-muted-foreground">{manualOrigin.name}</p>
                </div>
              </MarkerPopup>
            </MapMarker>
          )}

          <MapControls
            position="bottom-left"
            showZoom
            showCompass
            showFullscreen
          />
        </AppMap>

        {!pinTarget && <ViewportHud viewport={viewport} />}

        <div hidden={Boolean(pinTarget)} className="absolute left-3 top-20 z-20 flex max-h-[calc(100%-10rem)] max-w-[calc(100%-1.5rem)] flex-col items-start gap-2 overflow-y-auto [&[hidden]]:hidden">
          <div className="w-[min(360px,calc(100vw-1.5rem))] rounded-2xl border bg-card/95 p-3 shadow-lg backdrop-blur-md">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p role="status" className="text-sm font-semibold">{locationStatusMessage}</p>
                {locationError && (
                  <p className="mt-1 text-xs text-destructive">{locationError}</p>
                )}
                {locationCoordinatesLabel && (
                  <p className="mt-1 text-xs text-muted-foreground">{locationCoordinatesLabel}</p>
                )}
                {locationHint && (
                  <p className="mt-1 text-xs text-muted-foreground">{locationHint}</p>
                )}
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  {retryCount > 0 && <span className="rounded-full border px-2 py-1">Retries: {retryCount}</span>}
                  {locationSourceLabel && <span className="rounded-full border px-2 py-1">{locationSourceLabel}</span>}
                  <span className="rounded-full border px-2 py-1">
                    Permission: {locationPermissionState}
                  </span>
                </div>
              </div>
              {locationLoading && <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-muted-foreground" />}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={handleRetryLocationAccess}
                disabled={Boolean(environmentError) || locationPhase === "requesting"}
                aria-pressed={liveFix ? cameraMode === "follow" : undefined}
                className="gap-2"
              >
                <LocateFixed className="h-4 w-4" />
                {liveFix ? cameraMode === "follow" ? "Stop following" : "Follow my location"
                  : needsPermission ? "Enable location" : "Retry location"}
              </Button>
              {!liveFix && originMode === "live" && (
                <Button size="sm" variant="outline" onClick={() => {
                  setPlannerMinimized(false);
                  handleOriginInputChange("");
                }}>
                  Choose starting point
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={handle3DView}>
              <Mountain className="mr-1.5 h-4 w-4" />
              3D View
            </Button>
            <Button size="sm" variant="secondary" onClick={handleResetView}>
              <RotateCcw className="mr-1.5 h-4 w-4" />
              Reset
            </Button>
          </div>

          {(routeChoices.length > 0 || isLoadingRoutes) && (
            <section className="w-[min(330px,calc(100vw-1.5rem))] rounded-2xl border bg-card/95 p-3 shadow-lg backdrop-blur-md" aria-label="Route options">
              <button type="button" aria-expanded={showRouteChoices} onClick={() => setShowRouteChoices(!showRouteChoices)}
                className="flex w-full items-center justify-between gap-2 text-left text-sm font-semibold">
                <span className="flex items-center gap-2"><RouteIcon className="size-4 text-primary" />
                  {showSharedOnly ? "Leader's route" : "Route options"}
                </span>
                {showRouteChoices ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              </button>
              {showRouteChoices && (
                <div className="mt-2 space-y-2">
                  {isLoadingRoutes && <p role="status" className="text-xs text-muted-foreground">Finding driving routes...</p>}
                  {!isLoadingRoutes && !showSharedOnly && currentSearch?.options.length === 1 && currentSearch.options[0].route.mode === "routed" && !via && (
                    <p className="text-xs text-muted-foreground">The router found one driving route for these points.</p>
                  )}
                  <div className="space-y-1.5">
                    {routeChoices.map(({ id, route, label, fastest, color }) => (
                      <Button type="button" key={id} variant={route === selectedRoute ? "secondary" : "outline"} size="sm"
                        aria-pressed={route === selectedRoute} onClick={() => handleSelectRoute(route)}
                        className="h-auto min-h-10 w-full flex-wrap justify-start gap-x-2 gap-y-1 px-2.5 py-2 text-xs">
                        <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: route.mode === "direct" ? "#fbbf24" : color }} />
                        <span className="mr-auto font-semibold">{label}</span>
                        {route.mode === "routed" && <span className="flex items-center gap-1"><Clock className="size-3" />{formatDuration(route.duration)}</span>}
                        <span className="text-muted-foreground">{formatDistance(route.distance)}</span>
                        {fastest && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">Fastest</Badge>}
                      </Button>
                    ))}
                  </div>
                  {!isLeader && !sharedRoute && <p className="text-xs text-muted-foreground">Preview only. The leader chooses the shared route.</p>}
                  {isLeader && (
                    <div className="space-y-2">
                      {currentSearch?.viaMessage && <p role="status" className="text-xs text-muted-foreground">{currentSearch.viaMessage}</p>}
                      {routeOrigin && destination && (
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" variant="ghost" size="sm" onClick={() => handlePickPin("via")}>
                            <MapPin className="mr-1 size-3.5" />{via ? "Move via pin" : "Try another road"}
                          </Button>
                          {via && <Button type="button" variant="ghost" size="sm" onClick={() => setViaPin(null)}>Remove via pin</Button>}
                        </div>
                      )}
                      {canShareSelectedRoute && (
                        <Button type="button" size="sm" className="w-full" disabled={sharingRoute} onClick={() => void handleShareRoute()}>
                          {sharingRoute ? "Sharing..." : "Share with convoy"}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </div>

        <div className="absolute top-3 left-1/2 z-30 w-[min(680px,92vw)] -translate-x-1/2">
          {pinTarget ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border bg-card/95 px-4 py-3 shadow-lg" role="status">
              <p className="text-sm font-semibold">{pinTarget === "via" ? "Tap a road the convoy should pass through." : `Tap the map to place the ${pinTarget === "from" ? "starting point" : "destination"}.`}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => setPinTarget(null)}>Cancel</Button>
            </div>
          ) : plannerMinimized ? (
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-xl border bg-card/95 px-4 py-3 text-left shadow-lg backdrop-blur-md transition-colors hover:bg-card"
              onClick={() => setPlannerMinimized(false)}
            >
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Route Planner
                </p>
                <p className="truncate text-sm font-semibold">
                  {routeOriginLabel} to {routeDestinationLabel}
                </p>
                {routeError && <p className="mt-1 text-xs text-amber-700">{routeError}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {routeInfo?.durationMin != null && (
                  <span className="rounded-full border px-2 py-1 text-[11px] text-muted-foreground">
                    {Math.round(routeInfo.durationMin)} min
                  </span>
                )}
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </div>
            </button>
          ) : (
            <form
              className="space-y-2 rounded-xl border bg-card/95 p-3 shadow-lg backdrop-blur-md"
              onSubmit={(event) => {
                event.preventDefault();
                void handleApplyRouteSearch();
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Route Planner
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => setPlannerMinimized(true)}
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
              </div>

              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <div className="space-y-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    From
                  </p>
                  <Input
                    placeholder="Search a place or enter coordinates"
                    value={originInput}
                    aria-label="Starting point"
                    onFocus={(event) => { if (originMode === "live") event.currentTarget.select(); }}
                    onChange={(event) => handleOriginInputChange(event.target.value)}
                    className="flex-1"
                    disabled={applyingRoute}
                  />
                  <Button type="button" variant="ghost" size="sm" onClick={() => handlePickPin("from")} disabled={!mapReady || applyingRoute}>
                    <MapPin className="mr-1.5 size-3.5" /> Pin start
                  </Button>
                </div>

                <div className="space-y-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    To
                  </p>
                  <Input
                    aria-label="Destination"
                    placeholder="Search a place or enter coordinates"
                    value={destInput}
                    onChange={(event) => {
                      setPlannerMinimized(false);
                      setDestinationDraft(event.target.value);
                      setSelectedDestination(null);
                      setPlannerError(null);
                    }}
                    className="flex-1"
                    disabled={applyingRoute}
                  />
                  <Button type="button" variant="ghost" size="sm" onClick={() => handlePickPin("to")} disabled={!mapReady || applyingRoute}>
                    <MapPin className="mr-1.5 size-3.5" /> Pin destination
                  </Button>
                </div>

                <div className="flex items-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={originMode === "live" ? "secondary" : "outline"}
                    onClick={handleUseLiveOrigin}
                    disabled={applyingRoute || Boolean(environmentError) || locationPhase === "requesting"}
                    className="gap-2"
                  >
                    <LocateFixed className="h-4 w-4" />
                    My location
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!destInput.trim() || applyingRoute}
                    className="gap-2"
                  >
                    <Navigation className="h-4 w-4" />
                    {applyingRoute ? "Saving..." : "Go"}
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <Badge variant={originMode === "live" ? "secondary" : "outline"} className="text-[10px]">
                  {originMode === "live" ? liveFix ? "Live start" : "Start needed" : "Custom start"}
                </Badge>
                <span>
                  {originMode === "live"
                    ? liveFix
                      ? "Your starting point follows your live location."
                      : liveOriginWaitingMessage
                    : manualOrigin?.name || "Search for where you're starting from."}
                </span>
              </div>

              {(searchingOrigin || searchingDest) && (
                <p className="text-xs text-muted-foreground">
                  {searchingOrigin ? "Searching starting point…" : "Searching destination…"}
                </p>
              )}

              {(originSearchFailed || destinationSearchFailed) && (
                <p className="text-xs text-amber-700">Place search is unavailable. Enter latitude, longitude or pin the point on the map.</p>
              )}
              {selectedDestination && <p className="text-xs text-muted-foreground">Destination selected. Tap Go to use it.</p>}

              {originSuggestions.length > 0 && (
                <div className="max-h-56 overflow-auto rounded-lg border bg-popover shadow">
                  {originSuggestions.map((suggestion, index) => (
                    <button
                      key={`${suggestion.display_name}-origin-${index}`}
                      type="button"
                      className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => void handleSelectOrigin(suggestion)}
                    >
                      <span className="min-w-0 flex-1">{suggestion.display_name}</span>
                      {suggestion.category && (
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {suggestion.category}
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {destSuggestions.length > 0 && (
                <div className="max-h-56 overflow-auto rounded-lg border bg-popover shadow">
                  {destSuggestions.map((suggestion, index) => (
                    <button
                      key={`${suggestion.display_name}-${index}`}
                      type="button"
                      className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => void handleSelectDestination(suggestion)}
                    >
                      <span className="min-w-0 flex-1">{suggestion.display_name}</span>
                      {suggestion.category && (
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {suggestion.category}
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {!destInput.trim() && (
                <div className="rounded-lg border bg-muted/40 p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      Quick destination picks
                    </p>
                    <Badge variant="secondary" className="text-[10px]">
                      Tourist spots
                    </Badge>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {quickDestinationSuggestions.map((suggestion) => (
                      <button
                        key={suggestion.display_name}
                        type="button"
                        className="rounded-lg border bg-background px-3 py-2 text-left transition-colors hover:bg-muted"
                        onClick={() => void handleSelectDestination(suggestion)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="line-clamp-2 text-sm font-medium">
                            {suggestion.display_name}
                          </span>
                          {suggestion.category && (
                            <Badge variant="outline" className="shrink-0 text-[10px]">
                              {suggestion.category}
                            </Badge>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {routeInfo && (
                <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Ruler className="h-4 w-4" />
                    {routeInfo.distanceKm.toFixed(1)} km
                  </span>
                  {routeInfo.durationMin !== null && (
                    <span className="flex items-center gap-1">
                      <Clock className="h-4 w-4" />
                      {Math.round(routeInfo.durationMin)} min
                    </span>
                  )}
                </div>
              )}

              {(plannerError || routeError) && <p role="status" className="text-xs text-amber-700">{plannerError ?? routeError}</p>}

            </form>
          )}
        </div>

        {isLoadingRoutes && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/20">
            <div className="rounded-full border bg-card/95 p-4 shadow-lg backdrop-blur-sm">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}

        {showMembers && (
          <div className="absolute top-20 right-3 z-30 max-h-[60vh] w-72 overflow-y-auto rounded-xl border bg-card/95 p-4 shadow-xl backdrop-blur-md">
            <div className="space-y-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Users className="h-4 w-4" />
                Convoy Members
              </h3>

              {locations.map((location) => {
                const member = getMemberForLocation(location);
                if (!member) return null;

                const stale = isMemberLocationStale(location.updated_at, locationClock);
                return (
                  <div key={location.id} className="flex items-center gap-3 rounded-lg bg-muted/50 p-2">
                    <div
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: getMemberColor(member.role) }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {member.profiles?.display_name || "Unknown"}
                      </p>
                      <p className="text-xs capitalize text-muted-foreground">
                        {member.role}
                        {stale && (
                          <span className="ml-1 text-destructive">
                            <AlertTriangle className="inline h-3 w-3" /> stale
                          </span>
                        )}
                      </p>
                    </div>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {member.status.replace("_", " ")}
                    </Badge>
                  </div>
                );
              })}

              {locations.length === 0 && (
                <p className="py-2 text-center text-xs text-muted-foreground">
                  No location data yet
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border/50 bg-card/80 p-4 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm">
            <MapPin className="h-4 w-4 text-primary" />
            <span className="text-muted-foreground">
              {destination?.name || "No destination set"}
            </span>
          </div>

          <div className="flex gap-2">
            <Badge variant="outline" className="gap-1">
              <Users className="h-3 w-3" />
              {members.length} members
            </Badge>
            {routeInfo && (
              <Badge variant="secondary" className="gap-1">
                <Navigation className="h-3 w-3" />
                {routeInfo.distanceKm.toFixed(1)} km
                {routeInfo.durationMin !== null && ` · ${Math.round(routeInfo.durationMin)} min`}
              </Badge>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
