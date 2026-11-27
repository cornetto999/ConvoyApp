import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConvoyPosition } from "@/hooks/use-convoy-position";
import { isRoutingFix } from "@/lib/convoy-position";
import { GEOLOCATION_MAX_RETRIES, GEOLOCATION_RETRY_DELAY_MS, GEOLOCATION_TIMEOUT } from "@/lib/geolocation";

function createPosition(accuracy: number): GeolocationPosition {
  return {
    timestamp: Date.now(),
    coords: {
      latitude: 8.48, longitude: 124.65, accuracy,
      altitude: null, altitudeAccuracy: null, speed: null, heading: null,
      toJSON: () => ({}),
    },
    toJSON: () => ({}),
  };
}

function setupBrowser(state: PermissionState) {
  const permission = Object.assign(new EventTarget(), { state });
  const geolocation = {
    getCurrentPosition: vi.fn<(success: PositionCallback, error: PositionErrorCallback, options: PositionOptions) => void>(),
    watchPosition: vi.fn<(success: PositionCallback, error: PositionErrorCallback, options: PositionOptions) => number>()
      .mockImplementation(() => geolocation.watchPosition.mock.calls.length),
    clearWatch: vi.fn(),
  };
  vi.stubGlobal("navigator", {
    geolocation,
    permissions: { query: vi.fn(async () => permission) },
  });
  return { geolocation, permission };
}

async function mountTracker() {
  const hook = renderHook(() => useConvoyPosition(true));
  await act(async () => {});
  return hook;
}

const timeout: GeolocationPositionError = {
  code: GEOLOCATION_TIMEOUT, message: "Timeout", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3,
};

describe("convoy location recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("isSecureContext", true);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for a click when permission is pending and upgrades a coarse fix through the watch", async () => {
    const { geolocation, permission } = setupBrowser("prompt");
    const { result } = await mountTracker();

    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.phase).toBe("idle");
    expect(result.current.attempt).toBe(0);
    expect(geolocation.watchPosition).not.toHaveBeenCalled();

    act(() => result.current.retry.current());
    expect(result.current.phase).toBe("requesting");
    const [success, , options] = geolocation.getCurrentPosition.mock.calls[0];
    expect(options.enableHighAccuracy).toBe(false);

    act(() => {
      permission.state = "granted";
      permission.dispatchEvent(new Event("change"));
    });
    expect(geolocation.watchPosition).not.toHaveBeenCalled();

    act(() => success(createPosition(300)));
    expect(isRoutingFix(result.current.fix)).toBe(false);
    expect(geolocation.watchPosition.mock.calls[0][2].enableHighAccuracy).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
      geolocation.watchPosition.mock.calls[0][0](createPosition(12));
    });
    expect(isRoutingFix(result.current.fix)).toBe(true);
    expect(result.current.phase).toBe("tracking");
  });

  it("finishes a silent permission request without starting automatic retries", async () => {
    const { geolocation } = setupBrowser("prompt");
    const { result } = await mountTracker();

    act(() => result.current.retry.current());
    act(() => vi.advanceTimersByTime(30_000));

    expect(result.current.phase).toBe("unavailable");
    expect(result.current.permission).toBe("prompt");
    expect(result.current.attempt).toBe(0);
    expect(geolocation.watchPosition).not.toHaveBeenCalled();
  });

  it("stops restarting at the retry limit and accepts recovery from the last watch", async () => {
    const { geolocation } = setupBrowser("granted");
    const { result } = await mountTracker();

    for (let index = 0; index <= GEOLOCATION_MAX_RETRIES; index += 1) {
      act(() => geolocation.watchPosition.mock.calls[index][1](timeout));
      act(() => vi.advanceTimersByTime(GEOLOCATION_RETRY_DELAY_MS));
    }
    expect(result.current.phase).toBe("unavailable");
    expect(result.current.attempt).toBe(GEOLOCATION_MAX_RETRIES);
    expect(geolocation.watchPosition).toHaveBeenCalledTimes(GEOLOCATION_MAX_RETRIES + 1);

    act(() => geolocation.watchPosition.mock.calls.at(-1)![0](createPosition(12)));
    expect(result.current.phase).toBe("tracking");
    expect(result.current.error).toBeNull();
    expect(isRoutingFix(result.current.fix)).toBe(true);
  });
});
