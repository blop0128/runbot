export type LngLat = [number, number];

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineDistanceM(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;

  const R = 6371000;

  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

export function getPolylineLengthM(polyline: LngLat[]): number {
  let total = 0;

  for (let i = 1; i < polyline.length; i += 1) {
    total += haversineDistanceM(polyline[i - 1], polyline[i]);
  }

  return total;
}

export function getLngLatAtDistance(
  polyline: LngLat[],
  distanceM: number
): LngLat {
  if (polyline.length === 0) {
    throw new Error("Polyline is empty.");
  }

  if (polyline.length === 1) {
    return polyline[0];
  }

  if (distanceM <= 0) {
    return polyline[0];
  }

  let remaining = distanceM;

  for (let i = 1; i < polyline.length; i += 1) {
    const from = polyline[i - 1];
    const to = polyline[i];
    const segmentLength = haversineDistanceM(from, to);

    if (remaining <= segmentLength) {
      const ratio = remaining / segmentLength;

      const lng = from[0] + (to[0] - from[0]) * ratio;
      const lat = from[1] + (to[1] - from[1]) * ratio;

      return [lng, lat];
    }

    remaining -= segmentLength;
  }

  return polyline[polyline.length - 1];
}