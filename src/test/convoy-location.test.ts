import { describe, expect, it } from "vitest";
import { formatLiveSpeed, isRoutingFix, POSITION_MAX_AGE_MS, selectConvoyFix } from "@/lib/convoy-position";
import { parseCoordinateSuggestion } from "@/lib/convoy-place-search";

const now = 100_000;

function reading(accuracy: number, timestamp = now): GeolocationPosition {
  return {
    timestamp,
    coords: {
      latitude: 7.0731,
      longitude: 125.6128,
      accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: 0,
      speed: 3,
      toJSON: () => ({}),
    },
    toJSON: () => ({}),
  };
}

describe("convoy GPS fixes", () => {
  it("keeps a low-accuracy reading out of routing until the watch improves", () => {
    const rough = selectConvoyFix(null, reading(350, now - 1000), now);
    expect(rough?.accuracy).toBe(350);
    expect(isRoutingFix(rough, now)).toBe(false);

    const precise = selectConvoyFix(rough, reading(12), now);
    expect(isRoutingFix(precise, now)).toBe(true);
    expect(precise?.heading).toBe(0);
    expect(precise?.speed).toBeCloseTo(10.8);
  });

  it("does not replace a fresh precise fix with a rough or out-of-order reading", () => {
    const precise = selectConvoyFix(null, reading(15, now - 1000), now);
    expect(selectConvoyFix(precise, reading(200), now)).toBe(precise);
    expect(selectConvoyFix(precise, reading(10, now - 2000), now)).toBe(precise);
  });

  it("expires a previously precise reading and rejects stale or invalid browser data", () => {
    const precise = selectConvoyFix(null, reading(15), now);
    expect(isRoutingFix(precise, now + POSITION_MAX_AGE_MS)).toBe(false);
    expect(selectConvoyFix(null, reading(15, now - POSITION_MAX_AGE_MS), now)).toBeNull();
    expect(selectConvoyFix(null, reading(NaN), now)).toBeNull();
  });

  it("keeps a measured stop distinct from missing or expired speed", () => {
    const position = reading(12);
    const stationary = selectConvoyFix(null, { ...position, coords: { ...position.coords, speed: 0 } }, now);
    const unknown = selectConvoyFix(null, { ...position, coords: { ...position.coords, speed: null } }, now);

    expect(stationary?.speed).toBe(0);
    expect(unknown?.speed).toBeNull();
    expect(formatLiveSpeed(stationary?.speed ?? null)).toBe("0 km/h");
    expect(formatLiveSpeed(unknown?.speed ?? null)).toBe("No speed");
    expect(formatLiveSpeed(42, true)).toBe("Stale");
  });
});

describe("convoy coordinate input", () => {
  it("preserves exact coordinates in latitude, longitude order", () => {
    expect(parseCoordinateSuggestion("7.1301521, 125.6450236")).toMatchObject({
      lat: 7.1301521,
      lon: 125.6450236,
    });
    expect(parseCoordinateSuggestion("125.6450236, 7.1301521")).toBeNull();
    expect(parseCoordinateSuggestion("Davao City, Philippines")).toBeNull();
  });
});
