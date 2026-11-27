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
import { accuracyOutline, isRoutingFix, isValidCoordinate, type Coordinate } from "@/lib/convoy-position";
import { getQuickDestinationSuggestions, type DestinationSuggestion } from "@/lib/destination-suggestions";
import { getGeolocationErrorMessage } from "@/lib/geolocation";
import {
  Map as AppMap,
  MapClusterLayer,
  MapControls,
  MapMarker,
  MapPopup,
  MapRoute,
  MarkerContent,
  MarkerPopup,
  type MapRef,
  type MapViewport,
} from "@/components/ui/map";
import type { Convoy, ConvoyMember, MemberLocation, Profile } from "@/types/convoy";

type MemberWithProfile = ConvoyMember & { profiles: Profile | null };
type NamedCoordinate = Coordinate & { name: string };
type RouteCoordinate = [number, number];
type RouteOption = {
  coordinates: RouteCoordinate[];
  duration: number;
  distance: number;
  mode: "routed" | "direct";
};
type SpeedPointProperties = {
  userId: string;
  name: string;
  speed: number;
  role: string;
  updatedAt: string;
  stale: boolean;
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
const LIVE_ORIGIN_LABEL = "Your location";

function haversineMeters(a: Coordinate, b: Coordinate) {
  const R = 6371e3;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const aVal = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  const c = 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
  return R * c;
}

function formatDuration(seconds: number) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m`;
}

function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
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
  const [showMembers, setShowMembers] = useState(false);
  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [isLoadingRoutes, setIsLoadingRoutes] = useState(false);
  const [routeOrigin, setRouteOrigin] = useState<Coordinate | null>(null);
  const [originMode, setOriginMode] = useState<"live" | "manual">("live");
  const [originInput, setOriginInput] = useState(LIVE_ORIGIN_LABEL);
  const [manualOrigin, setManualOrigin] = useState<NamedCoordinate | null>(null);
  const [destination, setDestination] = useState<NamedCoordinate | null>(null);
  const [destinationDraft, setDestinationDraft] = useState<string | null>(null);
  const [selectedDestination, setSelectedDestination] = useState<NamedCoordinate | null>(null);
  const [applyingRoute, setApplyingRoute] = useState(false);
  const [pinTarget, setPinTarget] = useState<"from" | "to" | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const [plannerMinimized, setPlannerMinimized] = useState(false);
  const [viewport, setViewport] = useState<MapViewport>(DEFAULT_VIEWPORT);
  const [mapInstance, setMapInstance] = useState<MapRef | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [cameraLocked, setCameraLocked] = useState(false);
  const [mapViewMode, setMapViewMode] = useState<"members" | "speed">("members");
  const [dismissedGapAlertUserId, setDismissedGapAlertUserId] = useState<string | null>(null);
  const [selectedSpeedPoint, setSelectedSpeedPoint] = useState<{
    coordinates: RouteCoordinate;
    properties: SpeedPointProperties;
  } | null>(null);
  const quickDestinationSuggestions = useMemo(() => getQuickDestinationSuggestions(6), []);
  const {
    fix: myLocation, stale, attempt: retryCount, permission: locationPermissionState,
    error: gpsError, environmentError, retry: retryLocation,
  } = useConvoyPosition(Boolean(id && user));
  const liveFix = stale || !isRoutingFix(myLocation) ? null : myLocation;
  const gpsOutline = useMemo(() => myLocation ? accuracyOutline(myLocation) : [], [myLocation]);
  const destInput = destinationDraft ?? destination?.name ?? convoy?.destination_address ?? "";
  const { suggestions: originSuggestions, searching: searchingOrigin, failed: originSearchFailed } =
    useConvoyPlaceSearch(originInput, originMode === "manual" && !manualOrigin && !pinTarget);
  const { suggestions: destSuggestions, searching: searchingDest, failed: destinationSearchFailed } =
    useConvoyPlaceSearch(destInput, !selectedDestination && destinationDraft !== null && !pinTarget);

  const hasCenteredOnUserRef = useRef(false);
  const localDestinationRef = useRef(false);
  const convoyRequestRef = useRef(0);

  const selectedRoute = routeOptions[selectedRouteIndex] ?? null;
  const routeInfo = selectedRoute
    ? {
        distanceKm: selectedRoute.distance / 1000,
        durationMin: selectedRoute.mode === "routed" ? selectedRoute.duration / 60 : null,
      }
    : null;
  const routeOriginLabel = originMode === "live" ? liveFix ? "My location" : "Locating..."
    : manualOrigin?.name || originInput.trim() || "Custom start";
  const routeDestinationLabel = destination?.name || "No destination";
  const locationError = environmentError ?? (gpsError === null ? null : getGeolocationErrorMessage({ code: gpsError }));
  const locationLoading = !myLocation && !environmentError && locationPermissionState !== "denied";
  const locationStatusMessage = liveFix ? "Location locked"
    : locationPermissionState === "denied" ? "Location access needed"
    : environmentError ? "Location unavailable"
    : stale ? "Last known location"
    : myLocation ? "Improving accuracy..."
    : gpsError !== null ? "Weak signal, retrying..."
    : "Getting precise location...";
  const liveOriginWaitingMessage = locationError
    ? `${locationError} You can also pin a starting point.`
    : "Waiting for a location accurate to 50 m or better. You can also choose or pin a starting point.";
  const locationCoordinatesLabel = myLocation
    ? `Lat ${myLocation.lat.toFixed(5)}, Lng ${myLocation.lng.toFixed(5)} · Accuracy ±${Math.round(myLocation.accuracy)} m`
    : null;
  const locationSourceLabel = stale ? "Last known" : liveFix ? "Device location"
    : myLocation ? "Low accuracy" : "Davao map view";
  const locationHint = !liveFix && locationPermissionState !== "denied" && !environmentError
    ? "On your phone, enable Precise Location and keep the map open while it gets a fix."
    : null;

  const sortedRoutes = useMemo(
    () =>
      routeOptions
        .map((route, index) => ({ route, index }))
        .sort((a, b) => {
          if (a.index === selectedRouteIndex) return 1;
          if (b.index === selectedRouteIndex) return -1;
          return 0;
        }),
    [routeOptions, selectedRouteIndex],
  );

  const speedClusterData = useMemo(() => {
    const features = locations
      .map((location) => {
        const member = members.find((currentMember) => currentMember.user_id === location.user_id);
        if (!member) return null;

        return {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: [location.lng, location.lat] as [number, number],
          },
          properties: {
            userId: location.user_id,
            name: member.profiles?.display_name || "Unknown",
            speed: location.speed ?? 0,
            role: member.role,
            updatedAt: location.updated_at,
            stale: Date.now() - new Date(location.updated_at).getTime() > 30000,
          },
        };
      })
      .filter(Boolean);

    return {
      type: "FeatureCollection" as const,
      features,
    };
  }, [locations, members]);

  const gapAlert = useMemo<GapAlert | null>(() => {
    if (!destination || locations.length < 2) return null;

    const memberDistances = locations
      .map((location) => {
        const member = members.find((currentMember) => currentMember.user_id === location.user_id);
        if (!member || Date.now() - Date.parse(location.updated_at) > 30_000) return null;

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
  }, [convoy?.leader_id, destination, locations, members]);

  const activeGapAlert =
    gapAlert && dismissedGapAlertUserId !== gapAlert.userId ? gapAlert : null;

  useEffect(() => {
    if (!gapAlert) {
      setDismissedGapAlertUserId(null);
    }
  }, [gapAlert]);

  useEffect(() => {
    if (mapViewMode !== "speed") {
      setSelectedSpeedPoint(null);
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
        () => void loadConvoy(),
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

    return () => {
      supabase.removeChannel(channel);
      convoyRequestRef.current += 1;
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

  const centerOnFix = useCallback((fix: Coordinate) => {
    if (mapInstance) {
      mapInstance.easeTo({ center: [fix.lng, fix.lat], zoom: Math.max(mapInstance.getZoom(), 15), duration: 800 });
    } else {
      setViewport((current) => ({
        ...current,
        center: [fix.lng, fix.lat],
        zoom: Math.max(current.zoom, 15),
      }));
    }
  }, [mapInstance]);

  useEffect(() => {
    if (!liveFix || hasCenteredOnUserRef.current || cameraLocked || pinTarget
      || manualOrigin || destination) return;
    hasCenteredOnUserRef.current = true;
    centerOnFix(liveFix);
  }, [cameraLocked, centerOnFix, destination, liveFix, manualOrigin, pinTarget]);

  const handleRetryLocationAccess = () => {
    if (liveFix) centerOnFix(liveFix);
    else retryLocation.current();
  };

  const focusRouteIn3D = (origin: Coordinate | null, target: Coordinate | null) => {
    if (!origin || !mapInstance) return;
    setCameraLocked(true);
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

  const isStale = (updatedAt: string) =>
    Date.now() - new Date(updatedAt).getTime() > 30000;

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
    setRouteOptions([]);
    setSelectedRouteIndex(0);
    setRouteError(null);
    if (!destination || !routeOrigin) {
      setIsLoadingRoutes(false);
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort("timeout"), 12_000);
    const fetchRoute = async () => {
      setIsLoadingRoutes(true);
      let failureMessage = "Driving directions are unavailable. Showing straight-line distance.";
      try {
        const endpoints = `${routeOrigin.lng},${routeOrigin.lat};${destination.lng},${destination.lat}`;
        const url = `https://router.project-osrm.org/route/v1/driving/${endpoints}?overview=full&geometries=geojson&alternatives=true&radiuses=150;150`;
        const response = await fetch(url, { signal: controller.signal });
        const json = await response.json() as {
          code?: string;
          waypoints?: { distance: number }[];
          routes?: { geometry: { coordinates: RouteCoordinate[] }; distance: number; duration: number }[];
        };
        if (controller.signal.aborted) return;
        if (json.code === "NoSegment" || json.code === "NoRoute") {
          failureMessage = "No driving route connects these pins. Try placing the start or destination near a road entrance.";
        }
        if (!response.ok || json.code !== "Ok" || !json.routes?.length) throw new Error(failureMessage);

        setRouteOptions(json.routes.map((route) => ({
          coordinates: route.geometry.coordinates,
          distance: route.distance,
          duration: route.duration,
          mode: "routed",
        })));
        if (json.waypoints?.some(({ distance }) => distance > 40)) {
          setRouteError("The driving route starts or ends at a nearby road. Check the pin and use the entrance for a closer match.");
        }
      } catch {
        if (controller.signal.aborted && controller.signal.reason !== "timeout") return;
        setRouteOptions([{
          coordinates: [[routeOrigin.lng, routeOrigin.lat], [destination.lng, destination.lat]],
          distance: haversineMeters(routeOrigin, destination),
          duration: 0,
          mode: "direct",
        }]);
        setRouteError(failureMessage);
      } finally {
        clearTimeout(timeout);
        if (!controller.signal.aborted || controller.signal.reason === "timeout") setIsLoadingRoutes(false);
      }
    };

    void fetchRoute();
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [destination, routeOrigin]);

  const handleSelectOrigin = useCallback((suggestion: DestinationSuggestion) => {
    const { lat, lon, display_name: name } = suggestion;
    if (lat === undefined || lon === undefined || !isValidCoordinate(lat, lon)) return;
    setOriginMode("manual");
    setOriginInput(name);
    setManualOrigin({ name, lat, lng: lon });
    setPlannerError(null);
  }, []);

  const handleSelectDestination = useCallback((suggestion: DestinationSuggestion) => {
    const { lat, lon, display_name: name } = suggestion;
    if (lat === undefined || lon === undefined || !isValidCoordinate(lat, lon)) return;
    setDestinationDraft(name);
    setSelectedDestination({ name, lat, lng: lon });
    setPlannerError(null);
  }, []);

  const handlePickPin = (target: "from" | "to") => {
    setPinTarget(target);
    setPlannerError(null);
    setCameraLocked(true);
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
      else handleSelectDestination(coordinate);
      setPinTarget(null);
    };
    mapInstance.on("click", handleClick);
    return () => {
      canvas.style.cursor = previousCursor;
      mapInstance.off("click", handleClick);
    };
  }, [handleSelectDestination, handleSelectOrigin, mapInstance, pinTarget]);

  const handleOriginInputChange = (value: string) => {
    setOriginMode("manual");
    setOriginInput(value);
    setManualOrigin(null);
    setPlannerError(null);
  };

  const handleUseLiveOrigin = () => {
    setOriginMode("live");
    setOriginInput(LIVE_ORIGIN_LABEL);
    setManualOrigin(null);
    setPinTarget(null);
    setPlannerError(null);
    setRouteOrigin(liveFix);
    if (liveFix) centerOnFix(liveFix);
    else retryLocation.current();
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

    if (convoy?.leader_id === user?.id && target !== destination) {
      setApplyingRoute(true);
      try {
        const { data, error } = await supabase.from("convoys").update({
          destination_address: target.name,
          destination_lat: target.lat,
          destination_lng: target.lng,
        }).eq("id", id!).select("id").single();
        if (error || !data) throw error ?? new Error("Destination update was not applied");
      } catch {
        setPlannerError("The convoy destination could not be saved. Try again.");
        return;
      } finally {
        setApplyingRoute(false);
      }
      convoyRequestRef.current += 1;
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
    focusRouteIn3D(currentOrigin, target);
    setPlannerMinimized(true);
  };

  const routeBoundsPoints = useMemo<RouteCoordinate[]>(() => {
    if (!destination) return [];
    const endpoints: RouteCoordinate[] = [[destination.lng, destination.lat]];
    if (routeOrigin) endpoints.unshift([routeOrigin.lng, routeOrigin.lat]);
    return selectedRoute ? [...endpoints, ...selectedRoute.coordinates] : endpoints;
  }, [destination, routeOrigin, selectedRoute]);

  useEffect(() => {
    if (!mapInstance || !mapReady || cameraLocked || pinTarget || routeBoundsPoints.length === 0) return;

    if (routeBoundsPoints.length === 1) {
      mapInstance.easeTo({
        center: routeBoundsPoints[0],
        zoom: 14,
        duration: 700,
      });
      return;
    }

    const bounds = routeBoundsPoints.reduce(
      (currentBounds, coordinate) => currentBounds.extend(coordinate),
      new LngLatBounds(),
    );
    mapInstance.fitBounds(bounds, {
      duration: 900,
      maxZoom: 15,
      padding: { top: 140, right: 45, bottom: 90, left: 45 },
    });
  }, [cameraLocked, mapInstance, mapReady, pinTarget, routeBoundsPoints]);

  const visibleDestination = selectedDestination ?? destination;
  const handle3DView = () => focusRouteIn3D(plannedOrigin, visibleDestination);

  const handleResetView = () => {
    setCameraLocked(false);
    mapInstance?.easeTo({
      pitch: 0,
      bearing: 0,
      duration: 700,
    });
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
          viewport={viewport}
          onViewportChange={setViewport}
          maxPitch={60}
        >
          {myLocation && <MapRoute coordinates={gpsOutline} color={liveFix ? "#3b82f6" : "#64748b"} width={2} opacity={0.55} interactive={false} />}
          {sortedRoutes.map(({ route, index }) => {
            const isSelected = index === selectedRouteIndex;
            const isDirect = route.mode === "direct";

            return (
              <MapRoute
                key={`route-${index}`}
                id={`route-${index}`}
                coordinates={route.coordinates}
                color={isDirect ? (isSelected ? "hsl(var(--accent))" : "#fbbf24") : isSelected ? "#6366f1" : "#94a3b8"}
                width={isSelected ? 6 : 5}
                opacity={isSelected ? 1 : 0.6}
                dashArray={isDirect ? [2, 2] : undefined}
                interactive={!pinTarget}
                onClick={() => {
                  if (pinTarget) return;
                  setCameraLocked(false);
                  setSelectedRouteIndex(index);
                }}
              />
            );
          })}

          {mapViewMode === "members" &&
            locations.map((location) => {
              const member = getMemberForLocation(location);
              if (!member || location.user_id === userId) return null;

              const stale = isStale(location.updated_at);
              return (
                <MapMarker
                  key={location.id}
                  longitude={location.lng}
                  latitude={location.lat}
                  anchor="bottom"
                >
                  <MarkerContent>
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
                        Speed: {(location.speed ?? 0).toFixed(1)} km/h
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
                    Speed: {liveFix ? `${myLocation.speed.toFixed(1)} km/h` : "Unavailable"}
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
              onPointClick={(feature, coordinates) => {
                setSelectedSpeedPoint({
                  coordinates,
                  properties: feature.properties as SpeedPointProperties,
                });
              }}
            />
          )}

          {mapViewMode === "speed" && selectedSpeedPoint && (
            <MapPopup
              key={`${selectedSpeedPoint.coordinates[0]}-${selectedSpeedPoint.coordinates[1]}`}
              longitude={selectedSpeedPoint.coordinates[0]}
              latitude={selectedSpeedPoint.coordinates[1]}
              onClose={() => setSelectedSpeedPoint(null)}
              closeOnClick={false}
              focusAfterOpen={false}
              closeButton
            >
              <div className="space-y-1 p-1">
                <p className="text-sm font-semibold">{selectedSpeedPoint.properties.name}</p>
                <p className="text-sm">Speed: {selectedSpeedPoint.properties.speed.toFixed(1)} km/h</p>
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

        <div hidden={Boolean(pinTarget)} className="absolute left-3 top-20 z-20 flex flex-col gap-2 [&[hidden]]:hidden">
          <div className="w-[min(360px,calc(100vw-1.5rem))] rounded-2xl border bg-card/95 p-3 shadow-lg backdrop-blur-md">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{locationStatusMessage}</p>
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
                  <span className="rounded-full border px-2 py-1">
                    Retries: {retryCount}
                  </span>
                  <span className="rounded-full border px-2 py-1">
                    {locationSourceLabel}
                  </span>
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
                disabled={Boolean(environmentError)}
                className="gap-2"
              >
                <LocateFixed className="h-4 w-4" />
                {liveFix ? "Center on my location" : "Retry location"}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button size="sm" variant="secondary" onClick={handle3DView}>
              <Mountain className="mr-1.5 h-4 w-4" />
              3D View
            </Button>
            <Button size="sm" variant="secondary" onClick={handleResetView}>
              <RotateCcw className="mr-1.5 h-4 w-4" />
              Reset
            </Button>
          </div>

          {routeOptions.length > 0 && (
            <div className="flex max-w-[min(320px,calc(100vw-1.5rem))] flex-col gap-2">
              {routeOptions.map((route, index) => {
                const isActive = index === selectedRouteIndex;
                const isFastest = index === 0 && route.mode === "routed";

                return (
                  <Button
                    key={`route-option-${index}`}
                    variant={isActive ? "default" : "secondary"}
                    size="sm"
                    onClick={() => {
                      setCameraLocked(false);
                      setSelectedRouteIndex(index);
                    }}
                    className="justify-start gap-3 px-3 py-5"
                  >
                    {route.mode === "routed" && (
                      <div className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5" />
                        <span className="font-medium">{formatDuration(route.duration)}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 text-xs opacity-80">
                      <RouteIcon className="h-3 w-3" />
                      {formatDistance(route.distance)}
                    </div>
                    {isFastest && (
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900 dark:text-green-300">
                        Fastest
                      </span>
                    )}
                    {route.mode === "direct" && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                        Direct
                      </span>
                    )}
                  </Button>
                );
              })}
            </div>
          )}
        </div>

        <div className="absolute top-3 left-1/2 z-30 w-[min(680px,92vw)] -translate-x-1/2">
          {pinTarget ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border bg-card/95 px-4 py-3 shadow-lg" role="status">
              <p className="text-sm font-semibold">Tap the map to place the {pinTarget === "from" ? "starting point" : "destination"}.</p>
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
                    disabled={applyingRoute}
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
                  {originMode === "live" ? liveFix ? "Live start" : "Waiting for GPS" : "Custom start"}
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

              {locationError && (
                <p className="text-xs text-destructive">{locationError}</p>
              )}
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

                const stale = isStale(location.updated_at);
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
