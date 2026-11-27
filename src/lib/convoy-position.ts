export const ROUTING_ACCURACY_METERS = 50;
export const POSITION_MAX_AGE_MS = 30_000;

export type Coordinate = { lat: number; lng: number };
export type ConvoyFix = Coordinate & {
  accuracy: number;
  timestamp: number;
  speed: number | null;
  heading: number | null;
};

export function isValidCoordinate(lat: unknown, lng: unknown) {
  return typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90
    && typeof lng === "number" && Number.isFinite(lng) && Math.abs(lng) <= 180;
}

export function isFreshFix(fix: ConvoyFix, now = Date.now()) {
  return fix.timestamp <= now && now - fix.timestamp < POSITION_MAX_AGE_MS;
}

export function isRoutingFix(fix: ConvoyFix | null, now = Date.now()): fix is ConvoyFix {
  return fix !== null && fix.accuracy <= ROUTING_ACCURACY_METERS && isFreshFix(fix, now);
}

export function selectConvoyFix(
  previous: ConvoyFix | null,
  position: GeolocationPosition,
  now = Date.now(),
): ConvoyFix | null {
  const { latitude, longitude, accuracy, speed, heading } = position.coords;
  const { timestamp } = position;
  if (!isValidCoordinate(latitude, longitude) || !Number.isFinite(accuracy) || accuracy <= 0
    || !Number.isFinite(timestamp) || timestamp > now || now - timestamp >= POSITION_MAX_AGE_MS) {
    return previous;
  }

  if (previous && (previous.timestamp >= timestamp
    || (isRoutingFix(previous, now) && accuracy > ROUTING_ACCURACY_METERS))) {
    return previous;
  }

  return {
    lat: latitude,
    lng: longitude,
    accuracy,
    timestamp,
    speed: speed !== null && Number.isFinite(speed) && speed >= 0 ? speed * 3.6 : null,
    heading: heading !== null && Number.isFinite(heading) ? heading : null,
  };
}

export function formatLiveSpeed(speed: number | null, stale = false) {
  if (stale) return "Stale";
  if (speed === null || !Number.isFinite(speed) || speed < 0) return "No speed";
  return `${Number(speed.toFixed(1))} km/h`;
}

export function accuracyOutline({ lat, lng, accuracy }: ConvoyFix): [number, number][] {
  const toRadians = Math.PI / 180;
  const latitude = lat * toRadians;
  const angle = Math.min(accuracy, 100_000) / 6_371_000;
  return Array.from({ length: 65 }, (_, index) => {
    const bearing = 2 * Math.PI * (index % 64) / 64;
    const targetLat = Math.asin(
      Math.sin(latitude) * Math.cos(angle) + Math.cos(latitude) * Math.sin(angle) * Math.cos(bearing),
    );
    const longitudeOffset = Math.atan2(
      Math.sin(bearing) * Math.sin(angle) * Math.cos(latitude),
      Math.cos(angle) - Math.sin(latitude) * Math.sin(targetLat),
    );
    return [lng + longitudeOffset / toRadians, targetLat / toRadians];
  });
}
