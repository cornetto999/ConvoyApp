import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDrivingRoutes, parseDrivingRoute } from "@/lib/convoy-routing";

const start = { lat: 8.245, lng: 124.625 };
const destination = { lat: 8.21, lng: 124.61 };

afterEach(() => vi.unstubAllGlobals());

describe("convoy driving routes", () => {
  it("requests the saved endpoints and returns a route with distance and duration", async () => {
    const coordinates = [[124.625, 8.245], [124.617, 8.23], [124.61, 8.21]];
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: "Ok",
        routes: [{ geometry: { coordinates }, distance: 9011.9, duration: 1096 }],
        waypoints: [{ distance: 5 }, { distance: 65 }],
      }),
    });
    vi.stubGlobal("fetch", request);

    const result = await fetchDrivingRoutes(start, destination, new AbortController().signal);

    const url = new URL(request.mock.calls[0][0]);
    expect(url.pathname).toBe("/route/v1/driving/124.625,8.245;124.61,8.21");
    expect(url.searchParams.get("geometries")).toBe("geojson");
    expect(result.routes).toEqual([{ coordinates, distance: 9011.9, duration: 1096, mode: "routed" }]);
    expect(result.message).toContain("nearby road");
  });

  it("reports missing road connections without returning a driving line", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ code: "NoSegment" }),
    }));

    const result = await fetchDrivingRoutes(start, destination, new AbortController().signal);

    expect(result.routes).toEqual([]);
    expect(result.message).toContain("No driving route");
  });

  it("requests multiple alternatives and keeps each distinct driving line", async () => {
    const first = { geometry: { coordinates: [[124.625, 8.245], [124.61, 8.21]] }, distance: 8000, duration: 1000 };
    const second = { geometry: { coordinates: [[124.625, 8.245], [124.65, 8.23], [124.61, 8.21]] }, distance: 9500, duration: 1200 };
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: "Ok", routes: [first, first, second] }) });
    vi.stubGlobal("fetch", request);

    const { routes } = await fetchDrivingRoutes(start, destination, new AbortController().signal, true);

    expect(new URL(request.mock.calls[0][0]).searchParams.get("alternatives")).toBe("3");
    expect(routes.map(({ distance }) => distance)).toEqual([8000, 9500]);
  });

  it("requests a separately routed path through the chosen road pin", async () => {
    const via = { lat: 8.23, lng: 124.65 };
    const request = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ code: "NoRoute" }) });
    vi.stubGlobal("fetch", request);

    await fetchDrivingRoutes(start, destination, new AbortController().signal, true, via);

    const url = new URL(request.mock.calls[0][0]);
    expect(url.pathname).toBe("/route/v1/driving/124.625,8.245;124.65,8.23;124.61,8.21");
    expect(url.searchParams.get("radiuses")).toBe("150;150;150");
    expect(url.searchParams.get("alternatives")).toBe("false");
  });

  it("rejects invalid shared route data before rendering it", () => {
    const shared = { coordinates: [[124.625, 8.245], [124.61, 8.21]], duration: 800, distance: 6200 };
    expect(parseDrivingRoute(shared)).toEqual({ ...shared, mode: "routed" });
    expect(parseDrivingRoute({ ...shared, coordinates: [[181, 8], [124.61, 8.21]] })).toBeNull();
    expect(parseDrivingRoute({ ...shared, duration: -1 })).toBeNull();
  });
});
