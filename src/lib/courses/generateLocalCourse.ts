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

function getFallbackOutAndBackCourse(origin: LngLat): Course {
  const turnaround = destinationPoint(origin, 500, 90);

  return {
    id: `local-fallback-${Date.now()}`,
    name: "Current Location 1K Test",
    distanceM: 1000,
    polyline: [origin, turnaround, origin],
  };
}

export async function generateLocalOutAndBackCourse(params: {
  origin: LngLat;
  token: string;
  targetDistanceM?: number;
}): Promise<Course> {
  const { origin, token, targetDistanceM = 1000 } = params;

  const halfDistanceM = targetDistanceM / 2;
  const turnaround = destinationPoint(origin, halfDistanceM, 90);

  const coordinateString = [origin, turnaround, origin]
    .map(([lng, lat]) => `${lng},${lat}`)
    .join(";");

  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coordinateString}` +
    `?geometries=geojson&overview=full&steps=false&access_token=${token}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      console.warn("Mapbox Directions failed:", await response.text());
      return getFallbackOutAndBackCourse(origin);
    }

    const data = await response.json();
    const route = data.routes?.[0];

    if (!route?.geometry?.coordinates || !Array.isArray(route.geometry.coordinates)) {
      console.warn("Mapbox Directions returned invalid geometry:", data);
      return getFallbackOutAndBackCourse(origin);
    }

    return {
      id: `local-directions-${Date.now()}`,
      name: "Current Location 1K Test",
      distanceM: Math.round(route.distance ?? targetDistanceM),
      polyline: route.geometry.coordinates as LngLat[],
    };
  } catch (error) {
    console.warn("Failed to generate local course:", error);
    return getFallbackOutAndBackCourse(origin);
  }
}