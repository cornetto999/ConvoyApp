import { useEffect, useState, type ReactNode } from "react";
import {
  Clock,
  Compass,
  Hand,
  Loader2,
  MapPin,
  Mountain,
  Navigation,
  RotateCcw,
  Route,
  Settings2,
  Waypoints,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Map,
  MapControls,
  MapMarker,
  MapPopup,
  MapRoute,
  MarkerContent,
  MarkerLabel,
  MarkerPopup,
  MarkerTooltip,
  useMap,
} from "@/components/ui/map";

const routeStart = { name: "Davao City Hall", lng: 125.6106, lat: 7.0684 };
const routeEnd = { name: "Davao Airport", lng: 125.6467, lat: 7.1258 };

type RouteData = {
  coordinates: [number, number][];
  duration: number;
  distance: number;
};

const extensionIdeas = [
  {
    title: "Real-time tracking",
    description: "Live location updates for rides, convoy followers, or fleet management.",
    icon: Navigation,
  },
  {
    title: "Geofencing",
    description: "Trigger actions when users enter or leave specific areas.",
    icon: MapPin,
  },
  {
    title: "Heatmaps",
    description: "Visualize density data like population, crime, or activity hotspots.",
    icon: Compass,
  },
  {
    title: "Drawing tools",
    description: "Let users draw polygons, lines, or place markers for custom areas.",
    icon: Hand,
  },
  {
    title: "3D buildings",
    description: "Extrude building footprints for urban visualization and city planning views.",
    icon: Mountain,
  },
  {
    title: "Animations",
    description: "Animate markers along routes or create fly-through experiences.",
    icon: Route,
  },
  {
    title: "Custom data layers",
    description: "Overlay weather, traffic, or satellite imagery on top of the map.",
    icon: Settings2,
  },
] as const;

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

function ExampleCard({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description: string;
  icon: typeof Route;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden border-border/70 shadow-sm">
      <CardHeader className="border-b border-border/60 bg-card/60 backdrop-blur-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <CardTitle className="text-lg">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-4">{children}</CardContent>
    </Card>
  );
}

function RouteExample() {
  const [routes, setRoutes] = useState<RouteData[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchRoutes() {
      try {
        const response = await fetch(
          `https://router.project-osrm.org/route/v1/driving/${routeStart.lng},${routeStart.lat};${routeEnd.lng},${routeEnd.lat}?overview=full&geometries=geojson&alternatives=true`,
        );
        const data = await response.json();

        if (data.routes?.length > 0) {
          const routeData: RouteData[] = data.routes.map(
            (route: {
              geometry: { coordinates: [number, number][] };
              duration: number;
              distance: number;
            }) => ({
              coordinates: route.geometry.coordinates,
              duration: route.duration,
              distance: route.distance,
            }),
          );
          setRoutes(routeData);
        }
      } catch (error) {
        console.error("Failed to fetch routes:", error);
      } finally {
        setIsLoading(false);
      }
    }

    void fetchRoutes();
  }, []);

  const sortedRoutes = routes
    .map((route, index) => ({ route, index }))
    .sort((a, b) => {
      if (a.index === selectedIndex) return 1;
      if (b.index === selectedIndex) return -1;
      return 0;
    });

  return (
    <div className="relative h-[420px] w-full overflow-hidden rounded-xl border">
      <Map center={[125.628, 7.098]} zoom={11.4}>
        {sortedRoutes.map(({ route, index }) => {
          const isSelected = index === selectedIndex;
          return (
            <MapRoute
              key={index}
              coordinates={route.coordinates}
              color={isSelected ? "#6366f1" : "#94a3b8"}
              width={isSelected ? 6 : 5}
              opacity={isSelected ? 1 : 0.6}
              onClick={() => setSelectedIndex(index)}
            />
          );
        })}

        <MapMarker longitude={routeStart.lng} latitude={routeStart.lat}>
          <MarkerContent>
            <div className="h-5 w-5 rounded-full border-2 border-white bg-green-500 shadow-lg" />
            <MarkerLabel position="top">{routeStart.name}</MarkerLabel>
          </MarkerContent>
          <MarkerTooltip>{routeStart.name}</MarkerTooltip>
        </MapMarker>

        <MapMarker longitude={routeEnd.lng} latitude={routeEnd.lat}>
          <MarkerContent>
            <div className="h-5 w-5 rounded-full border-2 border-white bg-red-500 shadow-lg" />
            <MarkerLabel position="bottom">{routeEnd.name}</MarkerLabel>
          </MarkerContent>
          <MarkerTooltip>{routeEnd.name}</MarkerTooltip>
        </MapMarker>
      </Map>

      {routes.length > 0 && (
        <div className="absolute top-3 left-3 flex max-w-[280px] flex-col gap-2">
          {routes.map((route, index) => {
            const isActive = index === selectedIndex;
            const isFastest = index === 0;
            return (
              <Button
                key={index}
                variant={isActive ? "default" : "secondary"}
                size="sm"
                onClick={() => setSelectedIndex(index)}
                className="justify-start gap-3 px-3 py-5 shadow-sm"
              >
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  <span className="font-medium">{formatDuration(route.duration)}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs opacity-80">
                  <Route className="h-3 w-3" />
                  {formatDistance(route.distance)}
                </div>
                {isFastest && (
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900 dark:text-green-300">
                    Fastest
                  </span>
                )}
              </Button>
            );
          })}
        </div>
      )}

      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

function MapControlsExample() {
  return (
    <div className="h-[420px] w-full overflow-hidden rounded-xl border">
      <Map center={[124.6477, 8.4542]} zoom={11.2}>
        <MapControls
          position="bottom-right"
          showZoom
          showCompass
          showLocate
          showFullscreen
        />
      </Map>
    </div>
  );
}

function DraggableMarkerExample() {
  const [draggableMarker, setDraggableMarker] = useState({
    lng: 125.1716,
    lat: 6.1164,
  });

  return (
    <div className="h-[420px] w-full overflow-hidden rounded-xl border">
      <Map center={[125.1716, 6.1164]} zoom={12}>
        <MapMarker
          draggable
          longitude={draggableMarker.lng}
          latitude={draggableMarker.lat}
          onDragEnd={(lngLat) => {
            setDraggableMarker({ lng: lngLat.lng, lat: lngLat.lat });
          }}
        >
          <MarkerContent>
            <div className="cursor-move rounded-full">
              <Navigation
                className="fill-black stroke-white dark:fill-white dark:stroke-black"
                size={28}
              />
            </div>
          </MarkerContent>
          <MarkerPopup>
            <div className="space-y-1">
              <p className="font-medium text-foreground">Coordinates</p>
              <p className="text-xs text-muted-foreground">
                {draggableMarker.lat.toFixed(4)}, {draggableMarker.lng.toFixed(4)}
              </p>
            </div>
          </MarkerPopup>
        </MapMarker>
      </Map>
    </div>
  );
}

function StandalonePopupExample() {
  const [showPopup, setShowPopup] = useState(true);

  return (
    <div className="relative h-[420px] w-full overflow-hidden rounded-xl border">
      <Map center={[125.6128, 7.0731]} zoom={13}>
        {showPopup && (
          <MapPopup
            longitude={125.6128}
            latitude={7.0731}
            onClose={() => setShowPopup(false)}
            closeButton
            focusAfterOpen={false}
            closeOnClick={false}
            className="w-64"
          >
            <div className="space-y-2">
              <h3 className="font-semibold text-foreground">Davao City, Mindanao</h3>
              <p className="text-sm text-muted-foreground">
                A major gateway to Mindanao and the heart of many convoy routes in the south.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => setShowPopup(false)}
              >
                Close
              </Button>
            </div>
          </MapPopup>
        )}
      </Map>

      {!showPopup && (
        <Button
          size="sm"
          className="absolute bottom-4 left-4 z-10"
          onClick={() => setShowPopup(true)}
        >
          Show Popup
        </Button>
      )}
    </div>
  );
}

function MapController() {
  const { map, isLoaded } = useMap();
  const [pitch, setPitch] = useState(0);
  const [bearing, setBearing] = useState(0);

  useEffect(() => {
    if (!map || !isLoaded) return;

    const handleMove = () => {
      setPitch(Math.round(map.getPitch()));
      setBearing(Math.round(map.getBearing()));
    };

    map.on("move", handleMove);
    handleMove();

    return () => {
      map.off("move", handleMove);
    };
  }, [map, isLoaded]);

  const handle3DView = () => {
    map?.easeTo({
      pitch: 60,
      bearing: -20,
      duration: 1000,
    });
  };

  const handleReset = () => {
    map?.easeTo({
      pitch: 0,
      bearing: 0,
      duration: 1000,
    });
  };

  if (!isLoaded) return null;

  return (
    <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={handle3DView}>
          <Mountain className="mr-1.5 h-4 w-4" />
          3D View
        </Button>
        <Button size="sm" variant="secondary" onClick={handleReset}>
          <RotateCcw className="mr-1.5 h-4 w-4" />
          Reset
        </Button>
      </div>
      <div className="rounded-md border bg-background/90 px-3 py-2 font-mono text-xs backdrop-blur">
        <div>Pitch: {pitch}°</div>
        <div>Bearing: {bearing}°</div>
      </div>
    </div>
  );
}

function AdvancedUsageExample() {
  return (
    <div className="h-[420px] w-full overflow-hidden rounded-xl border">
      <Map center={[125.1278, 8.1575]} zoom={12.2}>
        <MapController />
      </Map>
    </div>
  );
}

export default function MapExamplesSection({
  className = "",
}: {
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="rounded-3xl border border-border/70 bg-gradient-to-br from-primary/10 via-background to-accent/10 p-6 shadow-sm">
        <div className="max-w-2xl space-y-3">
          <p className="inline-flex rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            Mindanao Map Playground
          </p>
          <h2 className="text-3xl font-bold tracking-tight">
            Live map examples set around Mindanao
          </h2>
          <p className="text-muted-foreground">
            These demos use the shared <code>src/components/ui/map.tsx</code> component and now
            focus on Mindanao locations like Davao City, Cagayan de Oro, General Santos, and Bukidnon.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ExampleCard
          title="Route Example"
          description="OSRM alternative routes through Davao with selectable route cards."
          icon={Waypoints}
        >
          <RouteExample />
        </ExampleCard>

        <ExampleCard
          title="Map Controls Example"
          description="Shows the built-in zoom, compass, locate, and fullscreen controls over Cagayan de Oro."
          icon={Compass}
        >
          <MapControlsExample />
        </ExampleCard>

        <ExampleCard
          title="Draggable Marker Example"
          description="Drag the marker around General Santos and watch the popup update live."
          icon={Hand}
        >
          <DraggableMarkerExample />
        </ExampleCard>

        <ExampleCard
          title="Standalone Popup Example"
          description="Open a popup without attaching it to a marker, centered on Davao City."
          icon={Navigation}
        >
          <StandalonePopupExample />
        </ExampleCard>
      </div>

      <div className="mt-6">
        <ExampleCard
          title="Advanced Usage Example"
          description="Inspect and control pitch and bearing directly over Bukidnon."
          icon={Settings2}
        >
          <AdvancedUsageExample />
        </ExampleCard>
      </div>

      <div className="mt-6 rounded-3xl border border-border/70 bg-card/70 p-6 shadow-sm backdrop-blur-sm">
        <div className="max-w-2xl space-y-3">
          <p className="inline-flex rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            Extend to Build
          </p>
          <h3 className="text-2xl font-bold tracking-tight">
            Build custom map features on top of the same Convoy map foundation
          </h3>
          <p className="text-muted-foreground">
            You can extend this shared map system into richer product features for live operations,
            analytics, and urban-style visualization.
          </p>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {extensionIdeas.map(({ title, description, icon: Icon }) => (
            <div
              key={title}
              className="rounded-2xl border border-border/70 bg-background/80 p-4 shadow-sm"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <p className="font-semibold">{title}</p>
                  <p className="text-sm text-muted-foreground">{description}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
