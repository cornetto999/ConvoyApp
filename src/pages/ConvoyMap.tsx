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
import {
  getCuratedDestinationSuggestions,
  getQuickDestinationSuggestions,
  mergeDestinationSuggestions,
  type DestinationSuggestion,
} from "@/lib/destination-suggestions";
import {
  GEOLOCATION_PERMISSION_DENIED,
  INITIAL_POSITION_OPTIONS,
  WATCH_POSITION_OPTIONS,
  getLastKnownLocation,
  getGeolocationErrorMessage,
  getGeolocationUnsupportedMessage,
  saveLastKnownLocation,
} from "@/lib/geolocation";
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
type Coordinate = { lat: number; lng: number };
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

function normalizeSuggestionLabel(value: string) {
  return value.trim().toLowerCase();
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
  const [myLocation, setMyLocation] = useState<Coordinate | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);
  const [isLoadingRoutes, setIsLoadingRoutes] = useState(false);
  const [routeOrigin, setRouteOrigin] = useState<Coordinate | null>(null);
  const [originMode, setOriginMode] = useState<"live" | "manual">("live");
  const [originInput, setOriginInput] = useState(LIVE_ORIGIN_LABEL);
  const [originSuggestions, setOriginSuggestions] = useState<DestinationSuggestion[]>([]);
  const [searchingOrigin, setSearchingOrigin] = useState(false);
  const [manualOrigin, setManualOrigin] = useState<NamedCoordinate | null>(null);
  const [destInput, setDestInput] = useState("");
  const [destSuggestions, setDestSuggestions] = useState<DestinationSuggestion[]>([]);
  const [searchingDest, setSearchingDest] = useState(false);
  const [destination, setDestination] = useState<{ name: string; lat: number; lng: number } | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
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

  const watchIdRef = useRef<number | null>(null);
  const locationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevLocationRef = useRef<Coordinate | null>(null);
  const hasCenteredOnUserRef = useRef(false);
  const skipOriginSearchRef = useRef(false);
  const skipDestinationSearchRef = useRef(false);
  const latestPositionRef = useRef<{
    lat: number;
    lng: number;
    speed: number;
    heading: number;
  } | null>(null);

  const applyRecoveredLocation = useCallback((next: {
    lat: number;
    lng: number;
    speed: number;
    heading: number;
  }) => {
    setMyLocation({ lat: next.lat, lng: next.lng });
    latestPositionRef.current = next;

    if (!hasCenteredOnUserRef.current) {
      hasCenteredOnUserRef.current = true;
      setViewport((current) => ({
        ...current,
        center: [next.lng, next.lat],
        zoom: Math.max(current.zoom, 13),
      }));
    }
  }, []);

  const selectedRoute = routeOptions[selectedRouteIndex] ?? null;
  const routeCoords = selectedRoute?.coordinates ?? [];
  const routeMode = selectedRoute?.mode ?? null;
  const routeInfo = selectedRoute
    ? {
        distanceKm: selectedRoute.distance / 1000,
        durationMin: selectedRoute.duration / 60,
      }
    : null;
  const routeOriginLabel =
    originMode === "live"
      ? myLocation
        ? "My location"
        : "Locating..."
      : manualOrigin?.name || originInput.trim() || "Custom start";
  const routeDestinationLabel = destination?.name || destInput.trim() || "No destination";

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
        if (!member) return null;

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
    startLocationTracking();

    const retryTracking = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      startLocationTracking();
    };

    window.addEventListener("focus", retryTracking);
    window.addEventListener("online", retryTracking);
    document.addEventListener("visibilitychange", retryTracking);

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
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      if (locationIntervalRef.current) clearInterval(locationIntervalRef.current);
      window.removeEventListener("focus", retryTracking);
      window.removeEventListener("online", retryTracking);
      document.removeEventListener("visibilitychange", retryTracking);
    };
  }, [applyRecoveredLocation, id, user]);

  const handleMapRef = useCallback((instance: MapRef | null) => {
    setMapInstance((current) => (current === instance ? current : instance));
  }, []);

  const loadConvoy = async () => {
    const { data, error } = await supabase.from("convoys").select("*").eq("id", id!).single();
    if (error) {
      toast.error(error.message || "Failed to load convoy");
      return;
    }

    setConvoy(data);

    if (!data?.destination_address) {
      setDestination(null);
      return;
    }

    if (data.destination_lat && data.destination_lng) {
      setDestination({
        name: data.destination_address,
        lat: data.destination_lat,
        lng: data.destination_lng,
      });
      setDestInput(data.destination_address);
      return;
    }

    const geo = await geocodeAddress(data.destination_address);
    if (!geo) return;

    setDestination({
      name: data.destination_address,
      lat: geo.lat,
      lng: geo.lng,
    });
    setDestInput(data.destination_address);

    await supabase
      .from("convoys")
      .update({
        destination_lat: geo.lat,
        destination_lng: geo.lng,
      })
      .eq("id", id!);
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

    const myStoredLocation = data.find((location) => location.user_id === user?.id);
    if (!myStoredLocation || latestPositionRef.current) return;

    const storedUpdatedAt = new Date(myStoredLocation.updated_at).getTime();

    applyRecoveredLocation({
      lat: myStoredLocation.lat,
      lng: myStoredLocation.lng,
      speed: myStoredLocation.speed ?? 0,
      heading: myStoredLocation.heading ?? 0,
    });
    saveLastKnownLocation({
      lat: myStoredLocation.lat,
      lng: myStoredLocation.lng,
      speed: myStoredLocation.speed ?? 0,
      heading: myStoredLocation.heading ?? 0,
      updatedAt: Number.isNaN(storedUpdatedAt) ? Date.now() : storedUpdatedAt,
    });
  };

  const pushLocationUpdate = async (next: {
    lat: number;
    lng: number;
    speed: number;
    heading: number;
  }) => {
    latestPositionRef.current = next;
    await supabase.from("member_locations").upsert(
      {
        convoy_id: id!,
        user_id: user!.id,
        lat: next.lat,
        lng: next.lng,
        heading: next.heading,
        speed: next.speed,
      },
      { onConflict: "convoy_id,user_id" },
    );
  };

  const syncCurrentPosition = async (coords: GeolocationCoordinates) => {
    const next = {
      lat: coords.latitude,
      lng: coords.longitude,
      heading: typeof coords.heading === "number" && !Number.isNaN(coords.heading) ? coords.heading : 0,
      speed:
        typeof coords.speed === "number" && !Number.isNaN(coords.speed) && coords.speed > 0
          ? coords.speed * 3.6
          : 0,
    };

    setMyLocation({ lat: next.lat, lng: next.lng });
    setLocationError(null);
    saveLastKnownLocation({
      lat: next.lat,
      lng: next.lng,
      heading: next.heading,
      speed: next.speed,
      updatedAt: Date.now(),
    });
    if (!hasCenteredOnUserRef.current) {
      hasCenteredOnUserRef.current = true;
      setViewport((current) => ({
        ...current,
        center: [next.lng, next.lat],
        zoom: Math.max(current.zoom, 14),
      }));
    }
    await pushLocationUpdate(next);
  };

  const resolveSuggestionCoordinates = async (suggestion: DestinationSuggestion) => {
    if (typeof suggestion.lat === "number" && typeof suggestion.lon === "number") {
      return { lat: suggestion.lat, lng: suggestion.lon };
    }

    return geocodeAddress(suggestion.display_name);
  };

  const resetRouteSelection = () => {
    setRouteOptions([]);
    setSelectedRouteIndex(0);
    setRouteError(null);
  };

  const focusRouteIn3D = useCallback(
    (origin?: Coordinate | null, target?: Coordinate | null) => {
      const activeOrigin = origin ?? routeOrigin ?? manualOrigin ?? myLocation;
      if (!activeOrigin || !mapInstance) return;

      const activeTarget = target ?? destination;
      const nextBearing = activeTarget
        ? getBearingDegrees(activeOrigin, activeTarget)
        : mapInstance.getBearing();

      setCameraLocked(true);
      mapInstance.easeTo({
        center: [activeOrigin.lng, activeOrigin.lat],
        zoom: Math.max(mapInstance.getZoom(), activeTarget ? 16 : 15),
        pitch: 65,
        bearing: nextBearing,
        duration: 1200,
      });
    },
    [destination, manualOrigin, mapInstance, myLocation, routeOrigin],
  );

  const handleLocationError = (
    error: GeolocationPositionError,
    { retrying = false }: { retrying?: boolean } = {},
  ) => {
    console.error("Geolocation error:", error);
    if (latestPositionRef.current && error.code !== GEOLOCATION_PERMISSION_DENIED) {
      setLocationError("Using your recent location while live GPS reconnects.");
      return;
    }

    setLocationError(getGeolocationErrorMessage(error, "tracking", retrying));
  };

  const beginWatch = () => {
    if (watchIdRef.current !== null) return;

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        void syncCurrentPosition(position.coords);
      },
      (error) => {
        const permissionDenied = error.code === GEOLOCATION_PERMISSION_DENIED;
        handleLocationError(error, { retrying: !permissionDenied });
        if (permissionDenied && watchIdRef.current !== null) {
          navigator.geolocation.clearWatch(watchIdRef.current);
          watchIdRef.current = null;
        }
      },
      WATCH_POSITION_OPTIONS,
    );
  };

  const startLocationTracking = () => {
    if (!("geolocation" in navigator)) {
      setLocationError(getGeolocationUnsupportedMessage("tracking"));
      return;
    }

    const cachedLocation = getLastKnownLocation();
    if (cachedLocation && !latestPositionRef.current) {
      applyRecoveredLocation(cachedLocation);
      setLocationError("Using your recent location while live GPS reconnects.");
    }

    beginWatch();

    navigator.geolocation.getCurrentPosition(
      (position) => {
        void syncCurrentPosition(position.coords);
        beginWatch();
      },
      (error) => {
        const permissionDenied = error.code === GEOLOCATION_PERMISSION_DENIED;
        handleLocationError(error, { retrying: !permissionDenied });
        if (!permissionDenied) {
          beginWatch();
        }
      },
      INITIAL_POSITION_OPTIONS,
    );

    if (locationIntervalRef.current) {
      clearInterval(locationIntervalRef.current);
    }
    locationIntervalRef.current = setInterval(() => {
      if (!latestPositionRef.current) return;
      void pushLocationUpdate(latestPositionRef.current);
    }, 5000);
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

  const buildFallbackRoute = useCallback(() => {
    const origin = routeOrigin || myLocation;
    if (!destination || !origin) return;

    const distance = haversineMeters(origin, destination);
    const duration = distance > 0 ? (distance / 1000 / 35) * 3600 : 0;
    setRouteOptions([
      {
        coordinates: [
          [origin.lng, origin.lat],
          [destination.lng, destination.lat],
        ],
        distance,
        duration,
        mode: "direct",
      },
    ]);
    setSelectedRouteIndex(0);
    setRouteError("Turn-by-turn routing is unavailable right now. Showing a direct path instead.");
  }, [destination, myLocation, routeOrigin]);

  useEffect(() => {
    if (!destination || !myLocation) {
      prevLocationRef.current = null;
      if (!destination) {
        setRouteOrigin(originMode === "manual" ? manualOrigin : myLocation);
        setRouteOptions([]);
        setSelectedRouteIndex(0);
        setIsLoadingRoutes(false);
        setRouteError(null);
        return;
      }

      if (originMode === "manual" && manualOrigin) {
        setRouteOrigin(manualOrigin);
        setIsLoadingRoutes(false);
        setRouteError(null);
        return;
      }

      setRouteOrigin(null);
      setRouteOptions([]);
      setSelectedRouteIndex(0);
      setIsLoadingRoutes(false);
      setRouteError("Waiting for your live location to start routing.");
      return;
    }

    if (originMode === "manual") {
      prevLocationRef.current = null;
      if (manualOrigin) {
        setRouteOrigin(manualOrigin);
        setRouteError(null);
      } else {
        setRouteOrigin(null);
        setRouteOptions([]);
        setSelectedRouteIndex(0);
        setIsLoadingRoutes(false);
        setRouteError("Search for a starting point or switch back to your live location.");
      }
      return;
    }

    const previousLocation = prevLocationRef.current;
    const distanceMoved = previousLocation ? haversineMeters(previousLocation, myLocation) : Infinity;

    if (!previousLocation || distanceMoved > REROUTE_THRESHOLD_METERS) {
      prevLocationRef.current = myLocation;
      setRouteOrigin(myLocation);
      setRouteError(null);
    }
  }, [destination, manualOrigin, myLocation, originMode]);

  useEffect(() => {
    if (!destination || !routeOrigin) {
      setRouteOptions([]);
      setSelectedRouteIndex(0);
      setIsLoadingRoutes(false);
      return;
    }

    const controller = new AbortController();

    const fetchRoute = async () => {
      setIsLoadingRoutes(true);
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${routeOrigin.lng},${routeOrigin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&alternatives=true`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Routing request failed with ${response.status}`);
        }

        const json = await response.json();
        const routes = (json?.routes || []) as Array<{
          geometry: { coordinates: RouteCoordinate[] };
          distance: number;
          duration: number;
        }>;
        if (routes.length === 0) {
          throw new Error("No route found");
        }

        setRouteOptions(
          routes.map((route) => ({
            coordinates: route.geometry.coordinates,
            distance: route.distance,
            duration: route.duration,
            mode: "routed" as const,
          })),
        );
        setSelectedRouteIndex(0);
        setRouteError(null);
      } catch (error) {
        if (!controller.signal.aborted) {
          buildFallbackRoute();
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingRoutes(false);
        }
      }
    };

    void fetchRoute();
    return () => controller.abort();
  }, [buildFallbackRoute, destination, routeOrigin]);

  useEffect(() => {
    if (selectedRouteIndex < routeOptions.length) return;
    setSelectedRouteIndex(0);
  }, [routeOptions, selectedRouteIndex]);

  useEffect(() => {
    if (!routeInfo) return;
    if (routeInfo.distanceKm >= 5) {
      toast.warning(`Destination is ${routeInfo.distanceKm.toFixed(1)} km away`, { duration: 4000 });
    }
  }, [routeInfo]);

  useEffect(() => {
    if (skipOriginSearchRef.current) {
      skipOriginSearchRef.current = false;
      setOriginSuggestions([]);
      setSearchingOrigin(false);
      return;
    }

    if (originMode === "live" || !originInput.trim()) {
      setOriginSuggestions([]);
      setSearchingOrigin(false);
      return;
    }

    const curatedSuggestions = getCuratedDestinationSuggestions(originInput, 6);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearchingOrigin(true);
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(originInput)}&format=json&limit=5`;
        const response = await fetch(url, {
          headers: { "Accept-Language": "en", "User-Agent": "ConvoyApp/1.0" },
          signal: controller.signal,
        });
        const json = await response.json();
        const remoteSuggestions = (json || []).map((result: { display_name: string; lat: string; lon: string }) => ({
          display_name: result.display_name,
          lat: parseFloat(result.lat),
          lon: parseFloat(result.lon),
          source: "search" as const,
        }));
        setOriginSuggestions(
          mergeDestinationSuggestions(curatedSuggestions, remoteSuggestions, 8),
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          setOriginSuggestions(curatedSuggestions);
        }
      } finally {
        setSearchingOrigin(false);
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [originInput, originMode]);

  useEffect(() => {
    if (skipDestinationSearchRef.current) {
      skipDestinationSearchRef.current = false;
      setDestSuggestions([]);
      setSearchingDest(false);
      return;
    }

    if (!destInput.trim()) {
      setDestSuggestions([]);
      setSearchingDest(false);
      return;
    }

    const curatedSuggestions = getCuratedDestinationSuggestions(destInput, 6);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearchingDest(true);
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(destInput)}&format=json&limit=5`;
        const response = await fetch(url, {
          headers: { "Accept-Language": "en", "User-Agent": "ConvoyApp/1.0" },
          signal: controller.signal,
        });
        const json = await response.json();
        const remoteSuggestions = (json || []).map((result: { display_name: string; lat: string; lon: string }) => ({
            display_name: result.display_name,
            lat: parseFloat(result.lat),
            lon: parseFloat(result.lon),
            source: "search" as const,
          }));
        setDestSuggestions(
          mergeDestinationSuggestions(curatedSuggestions, remoteSuggestions, 8),
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          setDestSuggestions(curatedSuggestions);
        }
      } finally {
        setSearchingDest(false);
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [destInput]);

  const geocodeAddress = async (address: string): Promise<Coordinate | null> => {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
      const response = await fetch(url, {
        headers: { "Accept-Language": "en", "User-Agent": "ConvoyApp/1.0" },
      });
      const json = await response.json();
      const hit = json?.[0];
      if (!hit) return null;

      return {
        lat: parseFloat(hit.lat),
        lng: parseFloat(hit.lon),
      };
    } catch (error) {
      return null;
    }
  };

  const persistDestination = async (next: { name: string; lat: number; lng: number }) => {
    const { error } = await supabase
      .from("convoys")
      .update({
        destination_address: next.name,
        destination_lat: next.lat,
        destination_lng: next.lng,
      })
      .eq("id", id!);

    if (error) {
      toast.error(error.message || "Failed to save destination");
    }
  };

  const handleSelectDestination = async (suggestion: DestinationSuggestion) => {
    skipDestinationSearchRef.current = true;
    const resolvedCoords = await resolveSuggestionCoordinates(suggestion);

    if (!resolvedCoords) {
      toast.error("We couldn't find that destination yet. Try a more specific place name.");
      return null;
    }

    const nextDestination = {
      name: suggestion.display_name,
      lat: resolvedCoords.lat,
      lng: resolvedCoords.lng,
    };

    setDestInput(suggestion.display_name);
    setDestSuggestions([]);
    setDestination(nextDestination);
    setViewport((current) => ({
      ...current,
      center: [resolvedCoords.lng, resolvedCoords.lat],
      zoom: Math.max(current.zoom, 12),
    }));
    setCameraLocked(false);
    prevLocationRef.current = null;
    setRouteOrigin(originMode === "manual" ? manualOrigin : myLocation);
    resetRouteSelection();
    setIsLoadingRoutes(Boolean(originMode === "manual" ? manualOrigin : myLocation));
    void persistDestination(nextDestination);
    return nextDestination;
  };

  const handleOriginInputChange = (value: string) => {
    setPlannerMinimized(false);
    setOriginMode("manual");
    setOriginInput(value);
    setManualOrigin(null);
    if (!value.trim()) {
      setOriginSuggestions([]);
      setRouteOrigin(null);
      setIsLoadingRoutes(false);
      setRouteError(destination ? "Search for a starting point or switch back to your live location." : null);
    }
  };

  const handleOriginInputFocus = () => {
    setPlannerMinimized(false);
    if (originMode !== "live") return;
    setOriginMode("manual");
    setOriginInput("");
    setManualOrigin(null);
    setOriginSuggestions([]);
  };

  const handleSelectOrigin = async (suggestion: DestinationSuggestion) => {
    skipOriginSearchRef.current = true;
    const resolvedCoords = await resolveSuggestionCoordinates(suggestion);

    if (!resolvedCoords) {
      toast.error("We couldn't find that starting point yet. Try a more specific place name.");
      return null;
    }

    const nextOrigin = {
      name: suggestion.display_name,
      lat: resolvedCoords.lat,
      lng: resolvedCoords.lng,
    };

    setOriginMode("manual");
    setOriginInput(suggestion.display_name);
    setOriginSuggestions([]);
    setManualOrigin(nextOrigin);
    setRouteOrigin(nextOrigin);
    setCameraLocked(false);
    prevLocationRef.current = null;
    setViewport((current) => ({
      ...current,
      center: [resolvedCoords.lng, resolvedCoords.lat],
      zoom: Math.max(current.zoom, 11.5),
    }));
    resetRouteSelection();
    setIsLoadingRoutes(Boolean(destination));
    return nextOrigin;
  };

  const handleUseLiveOrigin = () => {
    setPlannerMinimized(false);
    skipOriginSearchRef.current = true;
    setOriginMode("live");
    setOriginInput(LIVE_ORIGIN_LABEL);
    setOriginSuggestions([]);
    setManualOrigin(null);
    prevLocationRef.current = myLocation;
    setRouteOrigin(myLocation);
    resetRouteSelection();
    setIsLoadingRoutes(Boolean(destination && myLocation));
    if (!myLocation) {
      setRouteError("Waiting for your live location to start routing.");
    }
  };

  const handleApplyRouteSearch = async () => {
    const trimmedDestination = destInput.trim();
    if (!trimmedDestination) return;
    let activeOrigin = originMode === "manual" ? manualOrigin : myLocation;

    if (originMode === "manual") {
      const trimmedOrigin = originInput.trim();
      if (!trimmedOrigin) {
        toast.error("Enter a starting point or use your live location.");
        return;
      }

      const originMatchesManual =
        manualOrigin && normalizeSuggestionLabel(manualOrigin.name) === normalizeSuggestionLabel(trimmedOrigin);

      if (!originMatchesManual) {
        const originSuggestion =
          originSuggestions.find(
            (suggestion) =>
              normalizeSuggestionLabel(suggestion.display_name) === normalizeSuggestionLabel(trimmedOrigin),
          ) ?? {
            display_name: trimmedOrigin,
            source: "search" as const,
          };

        const originApplied = await handleSelectOrigin(originSuggestion);
        if (!originApplied) return;
        activeOrigin = originApplied;
      }
    }

    let activeDestination = destination;
    const destinationMatchesCurrent =
      destination && normalizeSuggestionLabel(destination.name) === normalizeSuggestionLabel(trimmedDestination);

    if (!destinationMatchesCurrent) {
      const destinationSuggestion =
        destSuggestions.find(
          (suggestion) =>
            normalizeSuggestionLabel(suggestion.display_name) === normalizeSuggestionLabel(trimmedDestination),
        ) ?? {
          display_name: trimmedDestination,
          source: "search" as const,
        };

      const destinationApplied = await handleSelectDestination(destinationSuggestion);
      if (!destinationApplied) return;
      activeDestination = destinationApplied;
    }

    if (activeOrigin && activeDestination) {
      if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      focusRouteIn3D(activeOrigin, activeDestination);
      setPlannerMinimized(true);
    }
  };

  const routeBoundsPoints = useMemo<RouteCoordinate[]>(() => {
    if (routeCoords.length > 0) return routeCoords;
    const activeOrigin = routeOrigin ?? manualOrigin ?? myLocation;

    if (activeOrigin && destination) {
      return [
        [activeOrigin.lng, activeOrigin.lat],
        [destination.lng, destination.lat],
      ];
    }
    if (activeOrigin) return [[activeOrigin.lng, activeOrigin.lat]];
    if (destination) return [[destination.lng, destination.lat]];
    return [];
  }, [destination, manualOrigin, myLocation, routeCoords, routeOrigin]);

  useEffect(() => {
    if (!mapInstance || !mapReady) return;
    if (cameraLocked) return;

    if (routeBoundsPoints.length === 0) {
      mapInstance.easeTo({
        center: DEFAULT_VIEWPORT.center,
        zoom: DEFAULT_VIEWPORT.zoom,
        duration: 700,
      });
      return;
    }

    if (routeBoundsPoints.length === 1) {
      mapInstance.easeTo({
        center: routeBoundsPoints[0],
        zoom: Math.max(mapInstance.getZoom(), 14),
        duration: 700,
      });
      return;
    }

    const bounds = routeBoundsPoints
      .slice(1)
      .reduce(
        (currentBounds, coordinate) => currentBounds.extend(coordinate),
        new LngLatBounds(routeBoundsPoints[0], routeBoundsPoints[0]),
      );

    mapInstance.fitBounds(bounds, {
      duration: 900,
      maxZoom: 15,
      padding: { top: 140, right: 80, bottom: 120, left: 80 },
    });
  }, [cameraLocked, mapInstance, mapReady, routeBoundsPoints]);

  const handle3DView = () => {
    focusRouteIn3D();
  };

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
              ) : locationError ? (
                <p className="max-w-[220px] truncate text-[11px] text-destructive">
                  {locationError}
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
          className="absolute inset-0"
          center={DEFAULT_VIEWPORT.center}
          zoom={DEFAULT_VIEWPORT.zoom}
          viewport={viewport}
          onViewportChange={setViewport}
          maxPitch={60}
        >
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
                onClick={() => {
                  setCameraLocked(false);
                  setSelectedRouteIndex(index);
                }}
              />
            );
          })}

          {mapViewMode === "members" &&
            locations.map((location) => {
              const member = getMemberForLocation(location);
              if (!member) return null;

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
            <MapMarker longitude={myLocation.lng} latitude={myLocation.lat} anchor="bottom">
              <MarkerContent>
                <div className="relative">
                  <ConvoyMarkerPin color="hsl(var(--primary))" label="Y" pulse />
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 rounded-full border bg-background/90 px-2 py-1 text-[10px] font-semibold shadow-sm">
                    You
                  </div>
                </div>
              </MarkerContent>
              <MarkerPopup className="min-w-[170px]">
                <div className="space-y-1">
                  <p className="font-semibold">Your location</p>
                  <p className="text-xs text-muted-foreground">
                    Speed: {(latestPositionRef.current?.speed ?? 0).toFixed(1)} km/h
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Heading: {(latestPositionRef.current?.heading ?? 0).toFixed(0)}°
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

          {destination && (
            <MapMarker longitude={destination.lng} latitude={destination.lat} anchor="bottom">
              <MarkerContent>
                <div className="relative">
                  <ConvoyMarkerPin color="hsl(var(--accent))" label="D" />
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 rounded-full border bg-background/90 px-2 py-1 text-[10px] font-semibold shadow-sm">
                    Destination
                  </div>
                </div>
              </MarkerContent>
              <MarkerPopup className="min-w-[200px]">
                <div className="space-y-1">
                  <p className="font-semibold">Destination</p>
                  <p className="text-xs text-muted-foreground">{destination.name}</p>
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
            showLocate
            showFullscreen
            onLocate={({ longitude, latitude }) => {
              setViewport((current) => ({
                ...current,
                center: [longitude, latitude],
                zoom: Math.max(current.zoom, 14),
              }));
            }}
          />
        </AppMap>

        <ViewportHud viewport={viewport} />

        <div className="absolute left-3 top-20 z-20 flex flex-col gap-2">
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
                    <div className="flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5" />
                      <span className="font-medium">{formatDuration(route.duration)}</span>
                    </div>
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
          {plannerMinimized ? (
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
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {routeInfo && (
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
                    placeholder="Your location or search a starting point"
                    value={originInput}
                    onFocus={handleOriginInputFocus}
                    onChange={(event) => handleOriginInputChange(event.target.value)}
                    className="flex-1"
                  />
                </div>

                <div className="space-y-1">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    To
                  </p>
                  <Input
                    placeholder="Search destination"
                    value={destInput}
                    onChange={(event) => {
                      setPlannerMinimized(false);
                      setDestInput(event.target.value);
                    }}
                    className="flex-1"
                  />
                </div>

                <div className="flex items-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={originMode === "live" ? "secondary" : "outline"}
                    onClick={handleUseLiveOrigin}
                    className="gap-2"
                  >
                    <LocateFixed className="h-4 w-4" />
                    My location
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!destInput.trim()}
                    className="gap-2"
                  >
                    <Navigation className="h-4 w-4" />
                    Go
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <Badge variant={originMode === "live" ? "secondary" : "outline"} className="text-[10px]">
                  {originMode === "live" ? "Using live location" : "Custom start"}
                </Badge>
                <span>
                  {originMode === "live"
                    ? myLocation
                      ? "Your route origin updates with your actual location."
                      : "Waiting for your actual location."
                    : manualOrigin?.name || "Search for where you're starting from."}
                </span>
              </div>

              {(searchingOrigin || searchingDest) && (
                <p className="text-xs text-muted-foreground">
                  {searchingOrigin ? "Searching starting point…" : "Searching destination…"}
                </p>
              )}

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
                  <span className="flex items-center gap-1">
                    <Clock className="h-4 w-4" />
                    {Math.round(routeInfo.durationMin)} min
                  </span>
                </div>
              )}

              {routeError && <p className="text-xs text-amber-600">{routeError}</p>}

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
                {routeInfo.distanceKm.toFixed(1)} km · {Math.round(routeInfo.durationMin)} min
              </Badge>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
