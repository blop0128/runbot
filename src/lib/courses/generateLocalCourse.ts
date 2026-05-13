export type LngLat = [number, number];

export type Course = {
  id: string;
  name: string;
  distanceM: number;
  polyline: LngLat[];
};

export type AutoLoopCourseCandidate = Course & {
  candidateId: string;
  distanceErrorM: number;
  isWithinTolerance: boolean;
  bearingDeg: number;
  endpoint: LngLat;
  straightDistanceM: number;
  outboundDistanceM: number;
};

type DirectionsRoute = {
  distance: number;
  geometry: {
    coordinates: LngLat[];
  };
};

type DirectionsResponse = {
  code?: string;
  routes?: DirectionsRoute[];
  message?: string;
};

type GenerateAutoLoopCourseCandidatesArgs = {
  origin: LngLat;
  token: string;
  targetDistanceM: number;
  toleranceM?: number;
};

type GenerateCustomWalkingCourseArgs = {
  start: LngLat;
  turnaround?: LngLat | null;
  finish: LngLat;
  token: string;
  name?: string;
};

const EARTH_RADIUS_M = 6_371_000;
const OUT_AND_BACK_ENDPOINT_TOLERANCE_M = 200;
const DEFAULT_DISTANCE_TOLERANCE_M = 500;
const MAX_CANDIDATES_TO_RETURN = 30;
const DIRECTIONS_PROFILE = "mapbox/walking";

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function normalizeLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function roundCoord(value: number): number {
  return Number(value.toFixed(6));
}

function roundPoint(point: LngLat): LngLat {
  return [roundCoord(point[0]), roundCoord(point[1])];
}

function haversineDistanceM(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;

  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaPhi = toRadians(lat2 - lat1);
  const deltaLambda = toRadians(lng2 - lng1);

  const sinHalfPhi = Math.sin(deltaPhi / 2);
  const sinHalfLambda = Math.sin(deltaLambda / 2);

  const h =
    sinHalfPhi * sinHalfPhi +
    Math.cos(phi1) * Math.cos(phi2) * sinHalfLambda * sinHalfLambda;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function destinationPoint(
  origin: LngLat,
  distanceM: number,
  bearingDeg: number
): LngLat {
  const [lng, lat] = origin;

  const angularDistance = distanceM / EARTH_RADIUS_M;
  const bearing = toRadians(bearingDeg);

  const phi1 = toRadians(lat);
  const lambda1 = toRadians(lng);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinAngularDistance = Math.sin(angularDistance);
  const cosAngularDistance = Math.cos(angularDistance);

  const phi2 = Math.asin(
    sinPhi1 * cosAngularDistance +
      cosPhi1 * sinAngularDistance * Math.cos(bearing)
  );

  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(bearing) * sinAngularDistance * cosPhi1,
      cosAngularDistance - sinPhi1 * Math.sin(phi2)
    );

  return roundPoint([normalizeLng(toDegrees(lambda2)), toDegrees(phi2)]);
}

function getPolylineLengthM(polyline: LngLat[]): number {
  let total = 0;

  for (let i = 1; i < polyline.length; i += 1) {
    total += haversineDistanceM(polyline[i - 1], polyline[i]);
  }

  return total;
}

function removeConsecutiveDuplicatePoints(polyline: LngLat[]): LngLat[] {
  const result: LngLat[] = [];

  polyline.forEach((point) => {
    const previous = result[result.length - 1];

    if (!previous) {
      result.push(point);
      return;
    }

    if (
      Math.abs(previous[0] - point[0]) > 0.000001 ||
      Math.abs(previous[1] - point[1]) > 0.000001
    ) {
      result.push(point);
    }
  });

  return result;
}

function joinPolylines(parts: LngLat[][]): LngLat[] {
  const result: LngLat[] = [];

  parts.forEach((part) => {
    part.forEach((point, index) => {
      const previous = result[result.length - 1];

      if (
        index === 0 &&
        previous &&
        Math.abs(previous[0] - point[0]) <= 0.000001 &&
        Math.abs(previous[1] - point[1]) <= 0.000001
      ) {
        return;
      }

      result.push(point);
    });
  });

  return removeConsecutiveDuplicatePoints(result);
}

function makeDirectionsUrl(points: LngLat[], token: string): string {
  const coordinates = points
    .map((point) => `${point[0]},${point[1]}`)
    .join(";");

  const params = new URLSearchParams({
    access_token: token,
    geometries: "geojson",
    overview: "full",
    steps: "false",
    alternatives: "false",
  });

  return `https://api.mapbox.com/directions/v5/${DIRECTIONS_PROFILE}/${coordinates}?${params.toString()}`;
}

async function fetchWalkingRoute(points: LngLat[], token: string): Promise<{
  distanceM: number;
  polyline: LngLat[];
}> {
  const response = await fetch(makeDirectionsUrl(points, token));

  if (!response.ok) {
    throw new Error(`Mapbox Directions 요청 실패: HTTP ${response.status}`);
  }

  const data = (await response.json()) as DirectionsResponse;

  if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
    throw new Error(data.message || "보행 경로를 찾지 못했습니다.");
  }

  const route = data.routes[0];

  return {
    distanceM: route.distance,
    polyline: removeConsecutiveDuplicatePoints(route.geometry.coordinates),
  };
}

function makeOutAndBackPolyline(outboundPolyline: LngLat[]): LngLat[] {
  const reversed = [...outboundPolyline].reverse();

  return joinPolylines([outboundPolyline, reversed]);
}

function makeCandidateKey(endpoint: LngLat): string {
  return `${endpoint[0].toFixed(5)},${endpoint[1].toFixed(5)}`;
}

function getEndpointRadiiM(targetDistanceM: number): number[] {
  const halfTarget = targetDistanceM / 2;
  const minRadius = Math.max(250, halfTarget - OUT_AND_BACK_ENDPOINT_TOLERANCE_M);
  const maxRadius = Math.max(minRadius, halfTarget + OUT_AND_BACK_ENDPOINT_TOLERANCE_M);

  const candidates = [
    halfTarget,
    halfTarget - 200,
    halfTarget + 200,
    halfTarget - 100,
    halfTarget + 100,
  ]
    .map((value) => Math.max(250, value))
    .filter((value) => value >= minRadius && value <= maxRadius);

  return Array.from(new Set(candidates.map((value) => Math.round(value))));
}

function getBearingCandidates(): number[] {
  return [
    0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330,
  ];
}

/**
 * 기존 RaceMap.tsx와의 호환성을 위해 함수명은 유지한다.
 *
 * 하지만 실제 생성 방식은 "loop"가 아니라 "out-and-back"이다.
 * 즉, 현재 위치에서 목표거리의 절반 정도 떨어진 지점까지 보행 경로를 만들고,
 * 같은 경로를 역순으로 돌아오는 코스를 만든다.
 */
export async function generateAutoLoopCourseCandidates({
  origin,
  token,
  targetDistanceM,
  toleranceM = DEFAULT_DISTANCE_TOLERANCE_M,
}: GenerateAutoLoopCourseCandidatesArgs): Promise<AutoLoopCourseCandidate[]> {
  if (!token) {
    throw new Error("Mapbox token이 없습니다.");
  }

  if (!Number.isFinite(targetDistanceM) || targetDistanceM <= 0) {
    throw new Error("목표 거리가 올바르지 않습니다.");
  }

  const bearings = getBearingCandidates();
  const radii = getEndpointRadiiM(targetDistanceM);

  const attempts: Array<{
    bearingDeg: number;
    radiusM: number;
    endpoint: LngLat;
  }> = [];

  bearings.forEach((bearingDeg) => {
    radii.forEach((radiusM) => {
      attempts.push({
        bearingDeg,
        radiusM,
        endpoint: destinationPoint(origin, radiusM, bearingDeg),
      });
    });
  });

  const seen = new Set<string>();
  const candidates: AutoLoopCourseCandidate[] = [];

  for (const attempt of attempts) {
    const key = makeCandidateKey(attempt.endpoint);

    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const outbound = await fetchWalkingRoute(
        [origin, attempt.endpoint],
        token
      );

      if (outbound.polyline.length < 2 || outbound.distanceM <= 0) {
        continue;
      }

      const outAndBackPolyline = makeOutAndBackPolyline(outbound.polyline);
      const distanceM = outbound.distanceM * 2;
      const distanceErrorM = Math.abs(distanceM - targetDistanceM);
      const straightDistanceM = haversineDistanceM(origin, attempt.endpoint);

      candidates.push({
        id: `out-and-back-${attempt.bearingDeg}-${Math.round(
          attempt.radiusM
        )}`,
        candidateId: `out-and-back-${attempt.bearingDeg}-${Math.round(
          attempt.radiusM
        )}`,
        name: `왕복 후보 ${candidates.length + 1}`,
        distanceM,
        distanceErrorM,
        isWithinTolerance: distanceErrorM <= toleranceM,
        bearingDeg: attempt.bearingDeg,
        endpoint: attempt.endpoint,
        straightDistanceM,
        outboundDistanceM: outbound.distanceM,
        polyline: outAndBackPolyline,
      });
    } catch (error) {
      console.warn("Failed to generate out-and-back candidate:", {
        attempt,
        error,
      });
    }
  }

  return candidates
    .sort((a, b) => {
      if (a.isWithinTolerance !== b.isWithinTolerance) {
        return a.isWithinTolerance ? -1 : 1;
      }

      return a.distanceErrorM - b.distanceErrorM;
    })
    .slice(0, MAX_CANDIDATES_TO_RETURN)
    .map((candidate, index) => ({
      ...candidate,
      id: `out-and-back-candidate-${index + 1}`,
      candidateId: `out-and-back-candidate-${index + 1}`,
      name: `왕복 후보 ${index + 1}`,
    }));
}

export async function generateCustomWalkingCourse({
  start,
  turnaround,
  finish,
  token,
  name = "커스텀 코스",
}: GenerateCustomWalkingCourseArgs): Promise<Course> {
  if (!token) {
    throw new Error("Mapbox token이 없습니다.");
  }

  const points = turnaround ? [start, turnaround, finish] : [start, finish];

  if (points.length < 2) {
    throw new Error("코스 생성을 위한 지점이 부족합니다.");
  }

  const route = await fetchWalkingRoute(points, token);

  if (route.polyline.length < 2) {
    throw new Error("코스 경로를 생성하지 못했습니다.");
  }

  return {
    id: `custom-course-${Date.now()}`,
    name,
    distanceM: route.distanceM,
    polyline: route.polyline,
  };
}

/**
 * 예전 테스트용 함수와의 호환성을 위한 export.
 * 현재 RaceMap에서는 사용하지 않아도 된다.
 */
export async function generateLocalOutAndBackCourse({
  origin,
  token,
  distanceM = 1000,
  bearingDeg = 90,
}: {
  origin: LngLat;
  token: string;
  distanceM?: number;
  bearingDeg?: number;
}): Promise<Course> {
  const endpoint = destinationPoint(origin, Math.max(250, distanceM / 2), bearingDeg);
  const outbound = await fetchWalkingRoute([origin, endpoint], token);
  const polyline = makeOutAndBackPolyline(outbound.polyline);

  return {
    id: `local-out-and-back-${Date.now()}`,
    name: `현재 위치 기준 왕복 ${(outbound.distanceM * 2 / 1000).toFixed(2)}km`,
    distanceM: outbound.distanceM * 2,
    polyline,
  };
}