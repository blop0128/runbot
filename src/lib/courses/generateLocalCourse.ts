export type LngLat = [number, number];

export type Course = {
  id: string;
  name: string;
  distanceM: number;
  polyline: LngLat[];
};

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function destinationPoint(
  start: LngLat,
  distanceM: number,
  bearingDegrees: number
): LngLat {
  const [lng, lat] = start;
  const radiusM = 6_371_000;

  const angularDistance = distanceM / radiusM;
  const bearing = toRadians(bearingDegrees);

  const lat1 = toRadians(lat);
  const lng1 = toRadians(lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );

  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  return [toDegrees(lng2), toDegrees(lat2)];
}

function createDenseFallbackOutAndBackCourse(origin: LngLat): Course {
  const turnaround = destinationPoint(origin, 500, 90);
  const outboundPoints = 18;
  const coordinates: LngLat[] = [];

  for (let i = 0; i <= outboundPoints; i += 1) {
    const ratio = i / outboundPoints;
    coordinates.push([
      origin[0] + (turnaround[0] - origin[0]) * ratio,
      origin[1] + (turnaround[1] - origin[1]) * ratio,
    ]);
  }

  for (let i = outboundPoints - 1; i >= 0; i -= 1) {
    const ratio = i / outboundPoints;
    coordinates.push([
      origin[0] + (turnaround[0] - origin[0]) * ratio,
      origin[1] + (turnaround[1] - origin[1]) * ratio,
    ]);
  }

  return {
    id: `local-fallback-${Date.now()}`,
    name: "현재 위치 1K 테스트 코스",
    distanceM: 1000,
    polyline: coordinates,
  };
}

async function fetchWalkingRoute(params: {
  origin: LngLat;
  destination: LngLat;
  token: string;
}): Promise<{ coordinates: LngLat[]; distanceM: number } | null> {
  const { origin, destination, token } = params;

  const coordinateString = [origin, destination]
    .map(([lng, lat]) => `${lng},${lat}`)
    .join(";");

  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coordinateString}` +
    `?geometries=geojson&overview=full&steps=false&access_token=${token}`;

  const response = await fetch(url);

  if (!response.ok) {
    console.warn("Mapbox Directions failed:", await response.text());
    return null;
  }

  const data = await response.json();
  const route = data.routes?.[0];

  if (!route?.geometry?.coordinates || !Array.isArray(route.geometry.coordinates)) {
    console.warn("Mapbox Directions returned invalid geometry:", data);
    return null;
  }

  const coordinates = route.geometry.coordinates as LngLat[];
  const distanceM = Number(route.distance);

  if (coordinates.length < 2 || !Number.isFinite(distanceM) || distanceM <= 0) {
    return null;
  }

  return {
    coordinates,
    distanceM,
  };
}

export async function generateLocalOutAndBackCourse(params: {
  origin: LngLat;
  token: string;
  targetDistanceM?: number;
}): Promise<Course> {
  const { origin, token, targetDistanceM = 1000 } = params;

  const halfDistanceM = targetDistanceM / 2;

  const candidateBearings = [90, 0, 180, 270];

  for (const bearing of candidateBearings) {
    try {
      const destination = destinationPoint(origin, halfDistanceM, bearing);

      const outboundRoute = await fetchWalkingRoute({
        origin,
        destination,
        token,
      });

      if (!outboundRoute) continue;

      const outbound = outboundRoute.coordinates;
      const inbound = outbound.slice(0, -1).reverse();

      const polyline = [...outbound, ...inbound];

      if (polyline.length < 3) continue;

      return {
        id: `local-directions-${Date.now()}`,
        name: "현재 위치 1K 테스트 코스",
        distanceM: Math.round(outboundRoute.distanceM * 2),
        polyline,
      };
    } catch (error) {
      console.warn("Failed bearing candidate:", bearing, error);
    }
  }

  return createDenseFallbackOutAndBackCourse(origin);
}