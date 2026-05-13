export type LngLat = [number, number];

export type Course = {
  id: string;
  name: string;
  distanceM: number;
  polyline: LngLat[];
};

export type AutoLoopCourseCandidate = Course & {
  candidateId: string;
  targetDistanceM: number;
  distanceErrorM: number;
  isWithinTolerance: boolean;
  waypoints: LngLat[];
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

function haversineDistanceM(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;

  const radiusM = 6_371_000;

  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) ** 2;

  return 2 * radiusM * Math.asin(Math.sqrt(h));
}

function isSamePoint(a: LngLat, b: LngLat): boolean {
  return haversineDistanceM(a, b) < 1;
}

function createDenseStraightSegment(from: LngLat, to: LngLat): {
  coordinates: LngLat[];
  distanceM: number;
} {
  const pointCount = 24;
  const coordinates: LngLat[] = [];

  for (let i = 0; i <= pointCount; i += 1) {
    const ratio = i / pointCount;

    coordinates.push([
      from[0] + (to[0] - from[0]) * ratio,
      from[1] + (to[1] - from[1]) * ratio,
    ]);
  }

  return {
    coordinates,
    distanceM: haversineDistanceM(from, to),
  };
}

function normalizeSegmentCoordinates(
  coordinates: LngLat[],
  from: LngLat,
  to: LngLat
): LngLat[] {
  const normalized = [...coordinates];

  if (normalized.length === 0) {
    return [from, to];
  }

  if (!isSamePoint(normalized[0], from)) {
    normalized.unshift(from);
  } else {
    normalized[0] = from;
  }

  if (!isSamePoint(normalized[normalized.length - 1], to)) {
    normalized.push(to);
  } else {
    normalized[normalized.length - 1] = to;
  }

  return normalized;
}

async function fetchWalkingSegment(params: {
  from: LngLat;
  to: LngLat;
  token: string;
}): Promise<{ coordinates: LngLat[]; distanceM: number }> {
  const { from, to, token } = params;

  if (isSamePoint(from, to)) {
    return {
      coordinates: [from],
      distanceM: 0,
    };
  }

  const coordinateString = [from, to]
    .map(([lng, lat]) => `${lng},${lat}`)
    .join(";");

  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coordinateString}` +
    `?geometries=geojson&overview=full&steps=false&access_token=${token}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      console.warn("Mapbox Directions failed:", await response.text());
      return createDenseStraightSegment(from, to);
    }

    const data = await response.json();
    const route = data.routes?.[0];

    if (
      !route?.geometry?.coordinates ||
      !Array.isArray(route.geometry.coordinates)
    ) {
      console.warn("Mapbox Directions returned invalid geometry:", data);
      return createDenseStraightSegment(from, to);
    }

    const rawCoordinates = route.geometry.coordinates as LngLat[];
    const distanceM = Number(route.distance);

    if (
      rawCoordinates.length < 2 ||
      !Number.isFinite(distanceM) ||
      distanceM <= 0
    ) {
      return createDenseStraightSegment(from, to);
    }

    return {
      coordinates: normalizeSegmentCoordinates(rawCoordinates, from, to),
      distanceM,
    };
  } catch (error) {
    console.warn("Failed to fetch walking segment:", error);
    return createDenseStraightSegment(from, to);
  }
}

async function fetchWalkingRouteThroughPoints(params: {
  points: LngLat[];
  token: string;
}): Promise<{ coordinates: LngLat[]; distanceM: number } | null> {
  const { points, token } = params;

  if (points.length < 2) return null;

  const coordinateString = points
    .map(([lng, lat]) => `${lng},${lat}`)
    .join(";");

  const url =
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coordinateString}` +
    `?geometries=geojson&overview=full&steps=false&access_token=${token}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      console.warn("Mapbox multi-point route failed:", await response.text());
      return null;
    }

    const data = await response.json();
    const route = data.routes?.[0];

    if (
      !route?.geometry?.coordinates ||
      !Array.isArray(route.geometry.coordinates)
    ) {
      console.warn("Mapbox multi-point route returned invalid geometry:", data);
      return null;
    }

    const rawCoordinates = route.geometry.coordinates as LngLat[];
    const distanceM = Number(route.distance);

    if (
      rawCoordinates.length < 2 ||
      !Number.isFinite(distanceM) ||
      distanceM <= 0
    ) {
      return null;
    }

    return {
      coordinates: normalizeSegmentCoordinates(
        rawCoordinates,
        points[0],
        points[points.length - 1]
      ),
      distanceM,
    };
  } catch (error) {
    console.warn("Failed to fetch walking route through points:", error);
    return null;
  }
}

function combineSegments(segments: LngLat[][]): LngLat[] {
  const combined: LngLat[] = [];

  segments.forEach((segment, segmentIndex) => {
    if (segment.length === 0) return;

    if (segmentIndex === 0) {
      combined.push(...segment);
      return;
    }

    combined.push(...segment.slice(1));
  });

  return combined;
}

function makeCandidateKey(points: LngLat[]): string {
  return points
    .map(([lng, lat]) => `${lng.toFixed(5)},${lat.toFixed(5)}`)
    .join("|");
}

export async function generateCustomWalkingCourse(params: {
  start: LngLat;
  finish: LngLat;
  turnaround?: LngLat | null;
  token: string;
  name?: string;
}): Promise<Course> {
  const { start, finish, turnaround, token, name = "커스텀 코스" } = params;

  if (!turnaround && isSamePoint(start, finish)) {
    throw new Error("시작지점과 종료지점이 같을 때는 반환점을 선택해야 합니다.");
  }

  const waypoints = turnaround ? [start, turnaround, finish] : [start, finish];

  const segmentCoordinates: LngLat[][] = [];
  let totalDistanceM = 0;

  for (let i = 1; i < waypoints.length; i += 1) {
    const from = waypoints[i - 1];
    const to = waypoints[i];

    const segment = await fetchWalkingSegment({
      from,
      to,
      token,
    });

    segmentCoordinates.push(segment.coordinates);
    totalDistanceM += segment.distanceM;
  }

  const polyline = combineSegments(segmentCoordinates);

  if (polyline.length < 2 || totalDistanceM <= 0) {
    throw new Error("코스를 생성하지 못했습니다. 다른 지점을 선택해 주세요.");
  }

  return {
    id: `custom-course-${Date.now()}`,
    name,
    distanceM: Math.round(totalDistanceM),
    polyline,
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
    const turnaround = destinationPoint(origin, halfDistanceM, bearing);

    try {
      return await generateCustomWalkingCourse({
        start: origin,
        turnaround,
        finish: origin,
        token,
        name: "현재 위치 1K 테스트 코스",
      });
    } catch (error) {
      console.warn("Failed local course candidate:", bearing, error);
    }
  }

  const fallbackTurnaround = destinationPoint(origin, halfDistanceM, 90);

  return generateCustomWalkingCourse({
    start: origin,
    turnaround: fallbackTurnaround,
    finish: origin,
    token,
    name: "현재 위치 1K 테스트 코스",
  });
}

export async function generateAutoLoopCourseCandidates(params: {
  origin: LngLat;
  token: string;
  targetDistanceM: number;
  toleranceM?: number;
}): Promise<AutoLoopCourseCandidate[]> {
  const { origin, token, targetDistanceM, toleranceM = 500 } = params;

  if (!Number.isFinite(targetDistanceM) || targetDistanceM <= 0) {
    throw new Error("목표 거리가 올바르지 않습니다.");
  }

  const bearings = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  const turnAngles = [70, 90, 110, 130, 150];
  const scaleFactors = [0.7, 0.82, 0.94, 1.06, 1.18, 1.3];

  const candidates: AutoLoopCourseCandidate[] = [];
  const seen = new Set<string>();
  let candidateIndex = 1;

  for (const baseBearing of bearings) {
    for (const turnAngle of turnAngles) {
      for (const scaleFactor of scaleFactors) {
        const radiusM =
          (targetDistanceM /
            (2 * (1 + Math.sin(toRadians(turnAngle) / 2)))) *
          scaleFactor;

        const waypointA = destinationPoint(origin, radiusM, baseBearing);
        const waypointB = destinationPoint(
          origin,
          radiusM,
          baseBearing + turnAngle
        );

        const points = [origin, waypointA, waypointB, origin];
        const key = makeCandidateKey(points);

        if (seen.has(key)) continue;
        seen.add(key);

        const route = await fetchWalkingRouteThroughPoints({
          points,
          token,
        });

        if (!route) continue;

        const distanceM = Math.round(route.distanceM);
        const distanceErrorM = Math.abs(distanceM - targetDistanceM);
        const isWithinTolerance = distanceErrorM <= toleranceM;

        candidates.push({
          id: `auto-loop-${Date.now()}-${candidateIndex}`,
          candidateId: `auto-loop-candidate-${candidateIndex}`,
          name: `자동 루프 후보 ${candidateIndex}`,
          distanceM,
          polyline: route.coordinates,
          targetDistanceM,
          distanceErrorM,
          isWithinTolerance,
          waypoints: points,
        });

        candidateIndex += 1;
      }
    }
  }

  return candidates.sort((a, b) => {
    if (a.isWithinTolerance !== b.isWithinTolerance) {
      return a.isWithinTolerance ? -1 : 1;
    }

    return a.distanceErrorM - b.distanceErrorM;
  });
}