import { useEffect, useRef, useState } from "react";
import { LngLatBounds } from "maplibre-gl";
import { Clock, ExternalLink, Loader2, LocateFixed, Navigation, Route } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Map as AppMap,
  MapControls,
  MapMarker,
  MapRoute,
  MarkerContent,
  MarkerPopup,
  type MapRef,
  useMap,
} from "@/components/ui/map";
import { useConvoyPosition } from "@/hooks/use-convoy-position";
import { isRoutingFix, type Coordinate } from "@/lib/convoy-position";
import { fetchDrivingRoutes, formatDistance, formatDuration, haversineMeters, type RouteOption } from "@/lib/convoy-routing";

type PreviewRoute = { origin: Coordinate; route: RouteOption };
const PREVIEW_REROUTE_METERS = 100;

function configureDestinationPreview(map: MapRef | null) {
  map?.touchZoomRotate.disableRotation();
}

function RouteOverlay({ origin, route, lat, lng }: PreviewRoute & Coordinate) {
  const { map, isLoaded } = useMap();
  const hasFramedRoute = useRef(false);

  useEffect(() => {
    if (!map || !isLoaded || hasFramedRoute.current) return;
    hasFramedRoute.current = true;
    const bounds = new LngLatBounds([origin.lng, origin.lat], [lng, lat]);
    route.coordinates.forEach((coordinate) => bounds.extend(coordinate));
    map.fitBounds(bounds, { padding: 32, maxZoom: 15, duration: 500 });
  }, [isLoaded, lat, lng, map, origin, route.coordinates]);

  return (
    <>
      <MapRoute coordinates={route.coordinates} color="#3b82f6" width={5} opacity={1} interactive={false} />
      <MapMarker longitude={origin.lng} latitude={origin.lat}>
        <MarkerContent>
          <div className="size-4 rounded-full border-2 border-white bg-blue-600 shadow-md" />
        </MarkerContent>
        <MarkerPopup>Route starting point</MarkerPopup>
      </MapMarker>
    </>
  );
}

export function DestinationRoutePreview({
  lat, lng, address, plannerPath,
}: Coordinate & { address: string; plannerPath: string }) {
  const [routeOrigin, setRouteOrigin] = useState<Coordinate | null>(null);
  const [preview, setPreview] = useState<PreviewRoute | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [routeMessage, setRouteMessage] = useState<string | null>(null);
  const [routeRetry, setRouteRetry] = useState(0);
  const { fix, stale, permission, environmentError, phase, retry } = useConvoyPosition(true);
  const liveFix = !stale && isRoutingFix(fix) ? fix : null;

  useEffect(() => {
    if (!liveFix) return;
    setRouteOrigin((previous) => previous && haversineMeters(previous, liveFix) < PREVIEW_REROUTE_METERS
      ? previous
      : liveFix);
  }, [liveFix]);

  useEffect(() => {
    if (!routeOrigin) return;
    const controller = new AbortController();
    setCalculating(true);
    setRouteMessage(null);
    void fetchDrivingRoutes(routeOrigin, { lat, lng }, controller.signal).then(({ routes, message }) => {
      if (controller.signal.aborted) return;
      setPreview(routes[0] ? { origin: routeOrigin, route: routes[0] } : null);
      setRouteMessage(message);
      setCalculating(false);
    });
    return () => controller.abort();
  }, [lat, lng, routeOrigin, routeRetry]);

  const handleShowRoute = () => {
    if (!liveFix) {
      retry.current();
    } else {
      setRouteOrigin(liveFix);
      setRouteRetry((previous) => previous + 1);
    }
  };

  const findingLocation = !liveFix && (phase === "requesting" || phase === "locating" || phase === "retrying");
  let status = "Use your location to see a driving route.";
  if (calculating) status = "Calculating the driving route...";
  else if (!preview && routeMessage) status = routeMessage;
  else if (preview && !liveFix) status = "Showing the route from your last precise location.";
  else if (preview) status = "Driving route from your location";
  else if (permission === "denied") status = "Location access is blocked. Choose a starting point in the route planner.";
  else if (environmentError) status = environmentError;
  else if (phase === "requesting" && permission !== "granted") status = "Allow location access in your browser to continue.";
  else if (phase === "unavailable") status = "Your location is unavailable. Try again or choose a starting point.";
  else if (findingLocation) status = fix ? "Waiting for a more precise location..." : "Finding your location...";

  const directionsUrl = new URL("https://www.google.com/maps/dir/");
  directionsUrl.search = new URLSearchParams({
    api: "1",
    destination: `${lat},${lng}`,
    travelmode: "driving",
    dir_action: "navigate",
  }).toString();

  return (
    <div className="space-y-3">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border">
        <AppMap
          ref={configureDestinationPreview}
          className="absolute inset-0"
          center={[lng, lat]}
          zoom={15}
          cooperativeGestures
          dragPan
          dragRotate={false}
          scrollZoom={{ around: "center" }}
          doubleClickZoom={false}
          boxZoom={false}
          touchZoomRotate={{ around: "center" }}
          touchPitch={false}
          keyboard={false}
          attributionControl={false}
        >
          <MapMarker longitude={lng} latitude={lat} anchor="bottom">
            <MarkerContent>
              <div className="relative flex flex-col items-center">
                <div className="relative flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-[hsl(var(--accent))] text-xs font-black text-white shadow-xl">
                  D
                </div>
                <div className="-mt-1 h-3 w-3 rotate-45 rounded-[2px] border-r-2 border-b-2 border-white bg-[hsl(var(--accent))] shadow-md" />
              </div>
            </MarkerContent>
            <MarkerPopup className="min-w-[180px]">
              <p className="font-semibold">Destination</p>
              <p className="text-xs text-muted-foreground">{address}</p>
            </MarkerPopup>
          </MapMarker>
          {preview && <RouteOverlay {...preview} lat={lat} lng={lng} />}
          <MapControls className="bottom-3 right-3" />
        </AppMap>
      </div>
      <div className="space-y-2">
        <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            {(calculating || findingLocation) && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            {status}
          </span>
          {preview && (
            <>
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                <Route className="size-4" aria-hidden="true" /> {formatDistance(preview.route.distance)}
              </span>
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                <Clock className="size-4" aria-hidden="true" /> {formatDuration(preview.route.duration)}
              </span>
            </>
          )}
        </div>
        {preview && routeMessage && <p className="text-xs text-muted-foreground">{routeMessage}</p>}
        <div className="flex flex-wrap gap-2">
          {!preview && !calculating && !findingLocation && !environmentError && (
            <Button size="sm" onClick={handleShowRoute}>
              <LocateFixed className="size-4" />
              {phase === "idle" && permission !== "denied" ? "Show my route" : "Try again"}
            </Button>
          )}
          <Button size="sm" variant="outline" asChild>
            <Link to={plannerPath}><Navigation className="size-4" /> Route planner</Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <a href={directionsUrl.href} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" /> Google Maps directions
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
