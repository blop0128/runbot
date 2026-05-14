"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import mapboxgl from "mapbox-gl";
import {
  generateAutoLoopCourseCandidates,
  generateCustomWalkingCourse,
  type AutoLoopCourseCandidate,
  type Course,
  type LngLat,
} from "@/lib/courses/generateLocalCourse";
import { useGpsTracker, type LatestGpsProjection } from "@/lib/gps/useGpsTracker";
import { DEFAULT_BOTS } from "@/lib/race/bots";
import { clampPaceSecPerKm, formatPace, paceToSpeedMps } from "@/lib/race/pace";
import {
  getLngLatAtDistance,
  getPolylineLengthM,
} from "@/lib/race/interpolate";

type PlayerMode = "pace" | "gps";
type ActivePanel = "setup" | "map";
type SetupView = "main" | "myCourses";
type CandidateMode = "outAndBack" | "oneWay";
type CustomRouteMode = "oneWay" | "outAndBack";
type DrawRouteInteractionMode = "draw" | "move";
type BottomSheetKind = "candidate" | "mapHud" | "custom" | "draw";
type CustomPointStep = "start" | "turnaround" | "finish";
type CustomGuide =
  | "select-start"
  | "add-turnaround"
  | "select-turnaround"
  | "select-finish"
  | "build-course"
  | null;

type RunnerHudState = {
  id: string;
  name: string;
  type: "player" | "bot";
  paceSecPerKm: number;
  distanceM: number;
  progressPercent: number;
  finished: boolean;
};

type CustomCoursePoints = {
  start: LngLat | null;
  turnaround: LngLat | null;
  finish: LngLat | null;
};

type CourseOrigin = "generated" | "custom" | "completed-import";

type StoredCourseRecord = Course & {
  courseId: string;
  favorite: boolean;
  source: CourseOrigin;
  createdAt: number;
  updatedAt: number;
  courseMode: CandidateMode | "custom" | "saved" | null;
  turnaround: LngLat | null;
  completionCount: number;
  lastCompletedAt: number | null;
  bestElapsedSec: number | null;
};

type RunRecord = {
  runId: string;
  courseId: string;
  courseName: string;
  distanceM: number;
  polyline: LngLat[];
  completedAt: number;
  elapsedSec: number | null;
  courseMode: CandidateMode | "custom" | "saved" | null;
  turnaround: LngLat | null;
  updatedAt: number;
};

type ElevationSummary =
  | {
      status: "loading";
    }
  | {
      status: "unavailable";
    }
  | {
      status: "ready";
      minM: number;
      maxM: number;
      startM: number;
      endM: number;
      gainM: number;
      lossM: number;
      samples: number;
    };

type TerrainQueryableMap = mapboxgl.Map & {
  setTerrain?: (terrain: { source: string; exaggeration?: number } | null) => void;
  queryTerrainElevation?: (
    lngLat: mapboxgl.LngLatLike,
    options?: { exaggerated?: boolean }
  ) => number | null;
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

const INITIAL_SELECTED_BOT_IDS: string[] = [];
const RUN_RECORDS_STORAGE_KEY = "runbot:runRecords:v1";
const COURSE_LIBRARY_STORAGE_KEY = "runbot:courseLibrary:v1";
const LEGACY_SAVED_COURSES_STORAGE_KEY = "runbot:savedCourses:v1";
const LEGACY_CUSTOM_COURSES_STORAGE_KEY = "runbot:customCourses:v1";
const AUTO_LOOP_PAGE_SIZE = 5;
const AUTO_LOOP_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6"];
const DEFAULT_DISTANCE_TOLERANCE_M = 500;
const MAX_ONE_WAY_CANDIDATES_TO_RETURN = 30;
const EARTH_RADIUS_M = 6_371_000;
const DIRECTIONS_PROFILE = "mapbox/walking";
const FEEDBACK_FORM_URL = "";
const TEST_PANEL_QUERY_PARAM = "devtools";
const COURSE_SEARCH_ABORT_MESSAGE = "COURSE_SEARCH_ABORTED";

const DEFAULT_CENTER: LngLat = [126.9205, 37.5297];

const DEFAULT_COURSE: Course = {
  id: "no-course-selected",
  name: "코스 미선택",
  distanceM: 0,
  polyline: [DEFAULT_CENTER, DEFAULT_CENTER],
};

const INITIAL_CUSTOM_POINTS: CustomCoursePoints = {
  start: null,
  turnaround: null,
  finish: null,
};

function isRunnableCourse(course: Course): boolean {
  return course.polyline.length >= 2 && getPolylineLengthM(course.polyline) > 1;
}

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

function makeDirectionsUrl(
  points: LngLat[],
  token: string,
  alternatives = false
): string {
  const coordinates = points
    .map((point) => `${point[0]},${point[1]}`)
    .join(";");

  const params = new URLSearchParams({
    access_token: token,
    geometries: "geojson",
    overview: "full",
    steps: "false",
    alternatives: alternatives ? "true" : "false",
  });

  return `https://api.mapbox.com/directions/v5/${DIRECTIONS_PROFILE}/${coordinates}?${params.toString()}`;
}

function throwIfCourseSearchAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error(COURSE_SEARCH_ABORT_MESSAGE);
  }
}

function isCourseSearchAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === COURSE_SEARCH_ABORT_MESSAGE)
  );
}

async function fetchWalkingRoute(
  points: LngLat[],
  token: string,
  signal?: AbortSignal
): Promise<{
  distanceM: number;
  polyline: LngLat[];
}> {
  throwIfCourseSearchAborted(signal);

  const response = await fetch(makeDirectionsUrl(points, token),
    signal ? { signal } : undefined
  );

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

async function fetchWalkingRouteVariants(
  points: LngLat[],
  token: string,
  alternatives = false,
  signal?: AbortSignal
): Promise<
  Array<{
    distanceM: number;
    polyline: LngLat[];
  }>
> {
  throwIfCourseSearchAborted(signal);

  const response = await fetch(makeDirectionsUrl(points, token, alternatives),
    signal ? { signal } : undefined
  );

  if (!response.ok) {
    throw new Error(`Mapbox Directions 요청 실패: HTTP ${response.status}`);
  }

  const data = (await response.json()) as DirectionsResponse;

  if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
    throw new Error(data.message || "보행 경로를 찾지 못했습니다.");
  }

  return data.routes
    .map((route) => ({
      distanceM: route.distance,
      polyline: removeConsecutiveDuplicatePoints(route.geometry.coordinates),
    }))
    .filter((route) => route.polyline.length >= 2 && route.distanceM > 0);
}

async function fetchWalkingRouteBySegments(
  points: LngLat[],
  token: string,
  signal?: AbortSignal
): Promise<{
  distanceM: number;
  polyline: LngLat[];
}> {
  throwIfCourseSearchAborted(signal);

  const cleaned = removeConsecutiveDuplicatePoints(points).filter((point, index, array) => {
    if (index === 0) return true;
    return haversineDistanceM(array[index - 1], point) >= 8;
  });

  if (cleaned.length < 2) {
    throw new Error("경로를 만들 수 있는 지점이 부족합니다.");
  }

  let totalDistanceM = 0;
  let mergedPolyline: LngLat[] = [];

  for (let index = 1; index < cleaned.length; index += 1) {
    throwIfCourseSearchAborted(signal);

    const from = cleaned[index - 1];
    const to = cleaned[index];

    if (haversineDistanceM(from, to) < 8) continue;

    const segment = await fetchWalkingRoute([from, to], token, signal);
    throwIfCourseSearchAborted(signal);

    totalDistanceM += segment.distanceM;

    if (mergedPolyline.length === 0) {
      mergedPolyline = segment.polyline;
    } else {
      mergedPolyline = [
        ...mergedPolyline,
        ...segment.polyline.slice(1),
      ];
    }
  }

  const polyline = removeConsecutiveDuplicatePoints(mergedPolyline);

  if (polyline.length < 2 || totalDistanceM <= 0) {
    throw new Error("보행 경로를 찾지 못했습니다.");
  }

  return {
    distanceM: totalDistanceM,
    polyline,
  };
}

function getBearingCandidates(): number[] {
  return [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
}

function getOneWayEndpointRadiiM(
  targetDistanceM: number,
  toleranceM: number
): number[] {
  const minRadius = Math.max(250, targetDistanceM - toleranceM);
  const maxRadius = Math.max(minRadius, targetDistanceM + toleranceM);

  const candidates = [
    targetDistanceM,
    targetDistanceM - 500,
    targetDistanceM + 500,
    targetDistanceM - 250,
    targetDistanceM + 250,
    targetDistanceM - 100,
    targetDistanceM + 100,
  ]
    .map((value) => Math.max(250, value))
    .filter((value) => value >= minRadius && value <= maxRadius);

  return Array.from(new Set(candidates.map((value) => Math.round(value))));
}

function makeCandidateKey(endpoint: LngLat): string {
  return `${endpoint[0].toFixed(5)},${endpoint[1].toFixed(5)}`;
}

async function generateOneWayCourseCandidates({
  origin,
  token,
  targetDistanceM,
  toleranceM = DEFAULT_DISTANCE_TOLERANCE_M,
  signal,
}: {
  origin: LngLat;
  token: string;
  targetDistanceM: number;
  toleranceM?: number;
  signal?: AbortSignal;
}): Promise<AutoLoopCourseCandidate[]> {
  throwIfCourseSearchAborted(signal);
  if (!token) {
    throw new Error("Mapbox token이 없습니다.");
  }

  if (!Number.isFinite(targetDistanceM) || targetDistanceM <= 0) {
    throw new Error("목표 거리가 올바르지 않습니다.");
  }

  const bearings = getBearingCandidates();
  const radii = getOneWayEndpointRadiiM(targetDistanceM, toleranceM);
  const seen = new Set<string>();
  const candidates: AutoLoopCourseCandidate[] = [];

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

  for (const attempt of attempts) {
    throwIfCourseSearchAborted(signal);

    const key = makeCandidateKey(attempt.endpoint);

    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const route = await fetchWalkingRoute([origin, attempt.endpoint], token, signal);
      throwIfCourseSearchAborted(signal);

      if (route.polyline.length < 2 || route.distanceM <= 0) {
        continue;
      }

      const distanceErrorM = Math.abs(route.distanceM - targetDistanceM);

      candidates.push({
        id: `one-way-${attempt.bearingDeg}-${Math.round(attempt.radiusM)}`,
        candidateId: `one-way-${attempt.bearingDeg}-${Math.round(
          attempt.radiusM
        )}`,
        name: `편도 후보 ${candidates.length + 1}`,
        distanceM: route.distanceM,
        distanceErrorM,
        isWithinTolerance: distanceErrorM <= toleranceM,
        bearingDeg: attempt.bearingDeg,
        endpoint: attempt.endpoint,
        straightDistanceM: haversineDistanceM(origin, attempt.endpoint),
        outboundDistanceM: route.distanceM,
        polyline: route.polyline,
      });
    } catch (error) {
      if (isCourseSearchAbortError(error)) {
        throw error;
      }

      console.warn("Failed to generate one-way candidate:", {
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
    .slice(0, MAX_ONE_WAY_CANDIDATES_TO_RETURN)
    .map((candidate, index) => ({
      ...candidate,
      id: `one-way-candidate-${index + 1}`,
      candidateId: `one-way-candidate-${index + 1}`,
      name: `편도 후보 ${index + 1}`,
    }));
}

function getDrawRouteWaypointSamples(points: LngLat[]): LngLat[] {
  if (points.length <= 2) return points;

  const lastIndex = points.length - 1;
  const indexes = [
    0,
    Math.round(lastIndex * 0.33),
    Math.round(lastIndex * 0.5),
    Math.round(lastIndex * 0.67),
    lastIndex,
  ];

  const uniqueIndexes = Array.from(new Set(indexes)).sort((a, b) => a - b);

  return uniqueIndexes.map((index) => points[index]);
}

function samplePolylineByRatio(polyline: LngLat[], ratio: number): LngLat {
  if (polyline.length === 0) return DEFAULT_CENTER;

  const distanceM = getPolylineLengthM(polyline);

  if (distanceM <= 0) {
    return polyline[Math.min(polyline.length - 1, Math.max(0, Math.round((polyline.length - 1) * ratio)))];
  }

  return getLngLatAtDistance(polyline, distanceM * Math.min(1, Math.max(0, ratio)));
}

function samplePolylineEvenly(polyline: LngLat[], count: number): LngLat[] {
  if (polyline.length === 0) return [];
  if (polyline.length === 1 || count <= 1) return [polyline[0]];

  const safeCount = Math.max(2, count);

  return Array.from({ length: safeCount }, (_, index) =>
    samplePolylineByRatio(polyline, index / (safeCount - 1))
  );
}

function getDrawnRouteCentroid(points: LngLat[]): LngLat {
  if (points.length === 0) return DEFAULT_CENTER;

  const sum = points.reduce(
    (acc, point) => {
      acc.lng += point[0];
      acc.lat += point[1];
      return acc;
    },
    { lng: 0, lat: 0 }
  );

  return [sum.lng / points.length, sum.lat / points.length];
}

function getDrawnRouteRadiusStats(points: LngLat[]): {
  averageRadiusM: number;
  maxRadiusM: number;
} {
  if (points.length === 0) {
    return { averageRadiusM: 0, maxRadiusM: 0 };
  }

  const center = getDrawnRouteCentroid(points);
  const distances = points.map((point) => haversineDistanceM(center, point));
  const sum = distances.reduce((acc, value) => acc + value, 0);

  return {
    averageRadiusM: sum / distances.length,
    maxRadiusM: Math.max(...distances),
  };
}

function isLikelyCircularDrawnRoute(points: LngLat[]): boolean {
  if (points.length < 12) return false;

  const start = points[0];
  const finish = points[points.length - 1];
  const drawnDistanceM = getPolylineLengthM(points);
  const closureDistanceM = haversineDistanceM(start, finish);
  const radiusStats = getDrawnRouteRadiusStats(points);

  if (drawnDistanceM < 450 || radiusStats.averageRadiusM < 80) return false;

  const closureLimitM = Math.min(420, Math.max(110, drawnDistanceM * 0.22));

  return closureDistanceM <= closureLimitM;
}

function getRepeatedLoopSignal(points: LngLat[]): {
  hasRepeatedArea: boolean;
  revisitCount: number;
  estimatedLapCount: number;
} {
  if (points.length < 16) {
    return { hasRepeatedArea: false, revisitCount: 0, estimatedLapCount: 1 };
  }

  const drawnDistanceM = getPolylineLengthM(points);
  const samples = samplePolylineEvenly(
    points,
    clampNumber(Math.ceil(drawnDistanceM / 28) + 1, 18, 180)
  );

  if (samples.length < 16) {
    return { hasRepeatedArea: false, revisitCount: 0, estimatedLapCount: 1 };
  }

  const origin = samples[0];
  const cellSizeM = 46;
  const visited = new Map<string, number>();
  let revisitCount = 0;

  samples.forEach((point, index) => {
    const local = toLocalMeters(point, origin);
    const key = `${Math.round(local.x / cellSizeM)},${Math.round(local.y / cellSizeM)}`;
    const previousIndex = visited.get(key);

    if (previousIndex !== undefined && index - previousIndex >= 8) {
      revisitCount += 1;
      return;
    }

    if (previousIndex === undefined) {
      visited.set(key, index);
    }
  });

  const revisitRatio = revisitCount / samples.length;
  const estimatedLapCount = Math.max(
    1,
    Math.min(4, Math.round(1 + revisitRatio * 4.2))
  );

  return {
    hasRepeatedArea: revisitCount >= 4 && revisitRatio >= 0.10,
    revisitCount,
    estimatedLapCount,
  };
}


type OutAndBackRepeatedLoopPattern = {
  stemPoints: LngLat[];
  loopPoints: LngLat[];
  loopEntry: LngLat;
  estimatedLapCount: number;
  stemDistanceM: number;
  loopDistanceM: number;
  returnMatchAverageM: number;
};

function reversePolyline(polyline: LngLat[]): LngLat[] {
  return [...polyline].reverse();
}

function estimateLoopLapCountByAngle(points: LngLat[]): number {
  if (points.length < 10) return 1;

  const center = getDrawnRouteCentroid(points);
  const samples = samplePolylineEvenly(points, 96);
  const angles = samples.map((point) => {
    const local = toLocalMeters(point, center);
    return Math.atan2(local.y, local.x);
  });

  if (angles.length < 3) return 1;

  let totalAbsAngle = 0;

  for (let index = 1; index < angles.length; index += 1) {
    let delta = angles[index] - angles[index - 1];

    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    totalAbsAngle += Math.abs(delta);
  }

  const lapCount = Math.round(totalAbsAngle / (Math.PI * 2));

  return clampNumber(lapCount, 1, 5);
}

function closeLoopWithEntry(points: LngLat[], entry: LngLat): LngLat[] {
  if (points.length === 0) return [entry, entry];

  const cleaned = removeConsecutiveDuplicatePoints(points);
  const result = cleaned.length > 0 ? [...cleaned] : [entry];

  result[0] = entry;

  const last = result[result.length - 1];
  if (!last || haversineDistanceM(last, entry) > 8) {
    result.push(entry);
  } else {
    result[result.length - 1] = entry;
  }

  return result;
}

function extractRepresentativeLoopLapPoints({
  loopPoints,
  loopEntry,
  estimatedLapCount,
}: {
  loopPoints: LngLat[];
  loopEntry: LngLat;
  estimatedLapCount: number;
}): LngLat[] {
  const cleaned = closeLoopWithEntry(loopPoints, loopEntry);
  const totalDistanceM = getPolylineLengthM(cleaned);
  const lapCount = clampNumber(Math.round(estimatedLapCount), 1, 5);

  if (cleaned.length < 4 || totalDistanceM < 120 || lapCount <= 1) {
    return cleaned;
  }

  const targetLapDistanceM = totalDistanceM / lapCount;
  const sampleCount = clampNumber(
    Math.ceil(targetLapDistanceM / 55) + 1,
    8,
    18
  );
  const lapPoints: LngLat[] = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const ratio = index / Math.max(1, sampleCount - 1);
    lapPoints.push(getLngLatAtDistance(cleaned, targetLapDistanceM * ratio));
  }

  return closeLoopWithEntry(lapPoints, loopEntry);
}

function repeatClosedLoopPolyline(polyline: LngLat[], lapCount: number): LngLat[] {
  const cleaned = removeConsecutiveDuplicatePoints(polyline);
  if (cleaned.length < 2) return cleaned;

  const safeLapCount = clampNumber(Math.round(lapCount), 1, 5);
  let repeated: LngLat[] = [...cleaned];

  for (let lapIndex = 1; lapIndex < safeLapCount; lapIndex += 1) {
    repeated = [...repeated, ...cleaned.slice(1)];
  }

  return removeConsecutiveDuplicatePoints(repeated);
}

async function fetchCircularizedLoopRoute({
  loopPoints,
  loopEntry,
  estimatedLapCount,
  token,
  signal,
}: {
  loopPoints: LngLat[];
  loopEntry: LngLat;
  estimatedLapCount: number;
  token: string;
  signal?: AbortSignal;
}): Promise<{ distanceM: number; polyline: LngLat[] }> {
  throwIfCourseSearchAborted(signal);

  const lapCount = clampNumber(Math.round(estimatedLapCount), 1, 5);
  const oneLapSketch = extractRepresentativeLoopLapPoints({
    loopPoints,
    loopEntry,
    estimatedLapCount: lapCount,
  });
  const oneLapSketchDistanceM = getPolylineLengthM(oneLapSketch);

  if (oneLapSketch.length < 4 || oneLapSketchDistanceM < 120) {
    throw new Error("원형 루프 구간을 만들 수 없습니다.");
  }

  const loopAttempts = getLoopWaypointAttempts(oneLapSketch)
    .map((attempt) => closeLoopWithEntry(attempt, loopEntry))
    .filter((attempt) => attempt.length >= 4)
    .slice(0, 6);

  let bestRoute: { distanceM: number; polyline: LngLat[]; score: number } | null = null;

  for (const attempt of loopAttempts) {
    throwIfCourseSearchAborted(signal);

    try {
      const route = await fetchWalkingRouteBySegments(attempt, token, signal);
      throwIfCourseSearchAborted(signal);

      const distanceErrorM = Math.abs(route.distanceM - oneLapSketchDistanceM);
      const score = calculateDrawRouteShapeScore({
        routePolyline: route.polyline,
        drawnPoints: oneLapSketch,
        distanceErrorM,
        isCircular: true,
      });

      if (!bestRoute || score < bestRoute.score) {
        bestRoute = { ...route, score };
      }
    } catch (error) {
      if (isCourseSearchAbortError(error)) {
        throw error;
      }

      console.warn("Failed to generate circularized loop lap route:", {
        attempt,
        error,
      });
    }
  }

  if (!bestRoute) {
    throw new Error("원형 루프 구간 경로를 찾지 못했습니다.");
  }

  return {
    distanceM: bestRoute.distanceM * lapCount,
    polyline: repeatClosedLoopPolyline(bestRoute.polyline, lapCount),
  };
}

function detectOutAndBackRepeatedLoopPattern(
  points: LngLat[]
): OutAndBackRepeatedLoopPattern | null {
  if (points.length < 28) return null;

  const drawnDistanceM = getPolylineLengthM(points);
  if (drawnDistanceM < 850) return null;

  const samples = samplePolylineEvenly(
    points,
    clampNumber(Math.ceil(drawnDistanceM / 24) + 1, 44, 150)
  );

  if (samples.length < 36) return null;

  const start = samples[0];
  const finish = samples[samples.length - 1];
  const endpointClosureM = haversineDistanceM(start, finish);
  const endpointClosureLimitM = Math.min(220, Math.max(70, drawnDistanceM * 0.09));

  // This composer is intentionally narrow: it targets the user's explicit case
  // of going out from the start, doing one or more loops, and returning along
  // the same stem. If the finish is not near the start, ordinary draw-route
  // candidates remain the safer fallback.
  if (endpointClosureM > endpointClosureLimitM) return null;

  const maxStemCount = Math.min(
    48,
    Math.max(8, Math.floor((samples.length - 12) / 3))
  );

  let bestMatch: {
    stemCount: number;
    averageM: number;
    maxM: number;
    score: number;
  } | null = null;

  for (let stemCount = 5; stemCount <= maxStemCount; stemCount += 1) {
    const stemPoints = samples.slice(0, stemCount);
    const stemDistanceM = getPolylineLengthM(stemPoints);

    if (stemDistanceM < 110) continue;

    const distances = stemPoints.map((point, index) => {
      const returnPoint = samples[samples.length - 1 - index];
      return haversineDistanceM(point, returnPoint);
    });
    const averageM =
      distances.reduce((acc, value) => acc + value, 0) / Math.max(1, distances.length);
    const maxM = Math.max(...distances);
    const allowedAverageM = Math.min(95, Math.max(38, stemDistanceM * 0.18));
    const allowedMaxM = Math.min(190, Math.max(90, stemDistanceM * 0.35));

    if (averageM > allowedAverageM || maxM > allowedMaxM) continue;

    // Prefer a longer and cleaner out-and-back stem. This makes the composer
    // choose the actual access path to the loop rather than a tiny closure near
    // the start point.
    const score = averageM + maxM * 0.28 - stemCount * 3.8;

    if (!bestMatch || score < bestMatch.score) {
      bestMatch = { stemCount, averageM, maxM, score };
    }
  }

  if (!bestMatch) return null;

  const stemPoints = samples.slice(0, bestMatch.stemCount);
  const loopStartIndex = Math.max(0, bestMatch.stemCount - 1);
  const loopEndIndex = Math.min(
    samples.length - 1,
    samples.length - bestMatch.stemCount
  );

  if (loopEndIndex - loopStartIndex < 10) return null;

  const loopEntry = samples[loopStartIndex];
  const rawLoopPoints = samples.slice(loopStartIndex, loopEndIndex + 1);
  const loopDistanceM = getPolylineLengthM(rawLoopPoints);
  const stemDistanceM = getPolylineLengthM(stemPoints);

  if (loopDistanceM < 360 || stemDistanceM < 110) return null;

  const loopClosureM = haversineDistanceM(
    rawLoopPoints[0],
    rawLoopPoints[rawLoopPoints.length - 1]
  );
  const loopClosureLimitM = Math.min(180, Math.max(60, loopDistanceM * 0.12));

  if (loopClosureM > loopClosureLimitM) return null;

  const loopSignal = getRepeatedLoopSignal(rawLoopPoints);
  const angleLapCount = estimateLoopLapCountByAngle(rawLoopPoints);
  const estimatedLapCount = Math.max(
    1,
    Math.min(5, Math.max(loopSignal.estimatedLapCount, angleLapCount))
  );

  // Require at least a loop-like body. A single lollipop loop is still allowed,
  // but the branch is especially valuable when estimatedLapCount >= 2.
  if (!loopSignal.hasRepeatedArea && angleLapCount < 1 && !hasOpenLoopGesture(rawLoopPoints)) {
    return null;
  }

  return {
    stemPoints,
    loopPoints: rawLoopPoints,
    loopEntry,
    estimatedLapCount,
    stemDistanceM,
    loopDistanceM,
    returnMatchAverageM: bestMatch.averageM,
  };
}

function makeOrderedSegmentAttempt(
  points: LngLat[],
  options: {
    maxPoints: number;
    minDistanceM: number;
    forceCloseTo?: LngLat;
  }
): LngLat[] {
  if (points.length < 2) return points;

  const distanceM = getPolylineLengthM(points);
  const count = clampNumber(
    Math.ceil(distanceM / options.minDistanceM) + 1,
    3,
    options.maxPoints
  );
  const sampled = samplePolylineEvenly(points, count);

  if (options.forceCloseTo && sampled.length >= 2) {
    sampled[sampled.length - 1] = options.forceCloseTo;
  }

  return compactWaypointAttempt(sampled, Math.max(10, options.minDistanceM * 0.45));
}

async function fetchOutAndBackRepeatedLoopRoute({
  pattern,
  token,
  signal,
}: {
  pattern: OutAndBackRepeatedLoopPattern;
  token: string;
  signal?: AbortSignal;
}): Promise<{ distanceM: number; polyline: LngLat[] }> {
  throwIfCourseSearchAborted(signal);

  const stemAttempt = makeOrderedSegmentAttempt(pattern.stemPoints, {
    maxPoints: 7,
    minDistanceM: 80,
    forceCloseTo: pattern.loopEntry,
  });

  if (stemAttempt.length < 2) {
    throw new Error("왕복 루프 진입 구간을 만들 수 없습니다.");
  }

  const stemRoute = await fetchWalkingRouteBySegments(stemAttempt, token, signal);
  throwIfCourseSearchAborted(signal);

  // The repeated local loop itself is intentionally routed by the circular-loop
  // generator instead of the raw ordered-segment generator. Raw repeated sketches
  // often contain scribbly overlap, and Mapbox Directions may preserve those
  // artifacts as ugly zigzags. This keeps one clean lap, then repeats that lap
  // according to the detected lap count.
  const loopRoute = await fetchCircularizedLoopRoute({
    loopPoints: pattern.loopPoints,
    loopEntry: pattern.loopEntry,
    estimatedLapCount: pattern.estimatedLapCount,
    token,
    signal,
  });
  throwIfCourseSearchAborted(signal);

  const returnPolyline = reversePolyline(stemRoute.polyline);
  const composedPolyline = removeConsecutiveDuplicatePoints([
    ...stemRoute.polyline,
    ...loopRoute.polyline.slice(1),
    ...returnPolyline.slice(1),
  ]);

  const composedDistanceM =
    stemRoute.distanceM * 2 + loopRoute.distanceM;

  if (composedPolyline.length < 2 || composedDistanceM <= 0) {
    throw new Error("왕복 루프 코스를 조립하지 못했습니다.");
  }

  return {
    distanceM: composedDistanceM,
    polyline: composedPolyline,
  };
}

function hasOpenLoopGesture(points: LngLat[]): boolean {
  if (points.length < 18) return false;

  const drawnDistanceM = getPolylineLengthM(points);
  if (drawnDistanceM < 650) return false;

  const samples = samplePolylineEvenly(
    points,
    clampNumber(Math.ceil(drawnDistanceM / 35) + 1, 18, 150)
  );

  if (samples.length < 18) return false;

  for (let index = 8; index < samples.length; index += 1) {
    const current = samples[index];
    const priorLimit = Math.max(0, index - 7);

    for (let priorIndex = 0; priorIndex < priorLimit; priorIndex += 1) {
      const distanceM = haversineDistanceM(current, samples[priorIndex]);

      if (distanceM <= 95) {
        return true;
      }
    }
  }

  return false;
}

function compactWaypointAttempt(
  attempt: LngLat[],
  minDistanceM = 35
): LngLat[] {
  const compact: LngLat[] = [];

  attempt.forEach((point, index) => {
    const previous = compact[compact.length - 1];
    const isEndpoint = index === 0 || index === attempt.length - 1;

    if (!previous || isEndpoint || haversineDistanceM(previous, point) >= minDistanceM) {
      compact.push(point);
    }
  });

  return compact;
}

function getShapePreservingWaypointAttempts(
  points: LngLat[],
  options: { closeToStart: boolean }
): LngLat[][] {
  if (points.length < 2) return [];

  const start = points[0];
  const finish = options.closeToStart ? start : points[points.length - 1];
  const drawnDistanceM = getPolylineLengthM(points);
  const baseCounts = drawnDistanceM >= 3200
    ? [8, 10, 12, 14, 16]
    : drawnDistanceM >= 1800
      ? [6, 8, 10, 12]
      : [5, 6, 8, 10];

  const attempts = baseCounts.map((count) => {
    const sampled = samplePolylineEvenly(points, count);

    if (sampled.length >= 2) {
      sampled[0] = start;
      sampled[sampled.length - 1] = finish;
    }

    return compactWaypointAttempt(sampled, drawnDistanceM >= 2500 ? 45 : 35);
  });

  const dense = getDrawRouteWaypointSamples(points);
  if (dense.length >= 2) {
    dense[0] = start;
    dense[dense.length - 1] = finish;
    attempts.push(compactWaypointAttempt(dense, 35));
  }

  return attempts.filter((attempt) => attempt.length >= 2);
}

function getDistancePreservingWaypointAttempt(
  points: LngLat[],
  options: {
    closeToStart: boolean;
    waypointCount: number;
    minDistanceM?: number;
  }
): LngLat[] {
  if (points.length < 2) return [];

  const start = points[0];
  const finish = options.closeToStart ? start : points[points.length - 1];
  const count = clampNumber(options.waypointCount, 3, 23);
  const sampled = samplePolylineEvenly(points, count);

  if (sampled.length < 2) return [];

  sampled[0] = start;
  sampled[sampled.length - 1] = finish;

  return compactWaypointAttempt(
    sampled,
    options.minDistanceM ?? 14
  );
}

function getLoopSegmentPreservingWaypointAttempts(
  points: LngLat[],
  options: { closeToStart: boolean }
): LngLat[][] {
  const drawnDistanceM = getPolylineLengthM(points);
  const repeatedSignal = getRepeatedLoopSignal(points);
  const hasLoop = repeatedSignal.hasRepeatedArea || hasOpenLoopGesture(points);

  if (points.length < 2 || drawnDistanceM < 450 || !hasLoop) return [];

  const baseCount = clampNumber(
    Math.ceil(drawnDistanceM / 180) + 1,
    9,
    23
  );
  const counts = Array.from(
    new Set([
      Math.max(7, baseCount - 4),
      Math.max(8, baseCount - 2),
      baseCount,
      Math.min(23, baseCount + 3),
    ])
  );

  const attempts = counts
    .map((count) =>
      getDistancePreservingWaypointAttempt(points, {
        closeToStart: options.closeToStart,
        waypointCount: count,
        minDistanceM: drawnDistanceM >= 2500 ? 18 : 12,
      })
    )
    .filter((attempt) => attempt.length >= 3);

  const seen = new Set<string>();

  return attempts.filter((attempt) => {
    const key = makeDrawAttemptKey(attempt);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getLoopWaypointAttempts(points: LngLat[]): LngLat[][] {
  if (points.length < 2) return [];

  const start = points[0];
  const fractionsList = [
    [0, 0.25, 0.5, 0.75],
    [0, 0.2, 0.4, 0.6, 0.8],
    [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6],
  ];

  const attempts = fractionsList.map((fractions) => {
    const sampled = fractions.map((ratio) => samplePolylineByRatio(points, ratio));
    return [...sampled, start];
  });

  attempts.unshift(...getLoopSegmentPreservingWaypointAttempts(points, { closeToStart: true }));

  // If the user draws a circular loop more than once, or draws a lollipop-style
  // loop with an approach section, sparse 4~6 point attempts collapse the loop.
  // These shape-preserving attempts sample the whole gesture in order, so repeated
  // laps and local loop portions can survive as ordered Mapbox waypoints.
  attempts.push(...getShapePreservingWaypointAttempts(points, { closeToStart: true }));

  const simplified = samplePolylineEvenly(points, 8);
  if (simplified.length >= 4) {
    attempts.push([...simplified.slice(0, -1), start]);
  }

  const seen = new Set<string>();

  return attempts
    .map((attempt) => {
      const compact = compactWaypointAttempt(attempt, 35);

      if (compact.length >= 2) {
        compact[0] = start;
        compact[compact.length - 1] = start;
      }

      return compact;
    })
    .filter((attempt) => attempt.length >= 4)
    .filter((attempt) => {
      const key = makeDrawAttemptKey(attempt);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function minDistanceToPolylineSamplesM(point: LngLat, samples: LngLat[]): number {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;

  return samples.reduce((best, sample) => {
    return Math.min(best, haversineDistanceM(point, sample));
  }, Number.POSITIVE_INFINITY);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getNearestSampleIndexAndDistance(
  point: LngLat,
  samples: LngLat[]
): { index: number; distanceM: number } {
  let bestIndex = -1;
  let bestDistanceM = Number.POSITIVE_INFINITY;

  samples.forEach((sample, index) => {
    const distanceM = haversineDistanceM(point, sample);

    if (distanceM < bestDistanceM) {
      bestDistanceM = distanceM;
      bestIndex = index;
    }
  });

  return { index: bestIndex, distanceM: bestDistanceM };
}

function bearingBetweenPointsDeg(a: LngLat, b: LngLat): number {
  const phi1 = toRadians(a[1]);
  const phi2 = toRadians(b[1]);
  const lambda1 = toRadians(a[0]);
  const lambda2 = toRadians(b[0]);
  const deltaLambda = lambda2 - lambda1;

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function angleDeltaDeg(a: number, b: number): number {
  return Math.abs((((b - a + 540) % 360) + 360) % 360 - 180);
}

function calculateSharpTurnPenaltyM(routePolyline: LngLat[]): number {
  const routeLengthM = getPolylineLengthM(routePolyline);
  const routeSamples = samplePolylineEvenly(
    routePolyline,
    clampNumber(Math.ceil(routeLengthM / 35) + 1, 8, 120)
  );

  if (routeSamples.length < 4) return 0;

  const bearings: number[] = [];

  for (let index = 1; index < routeSamples.length; index += 1) {
    const previous = routeSamples[index - 1];
    const current = routeSamples[index];

    if (haversineDistanceM(previous, current) < 10) continue;
    bearings.push(bearingBetweenPointsDeg(previous, current));
  }

  let penaltyM = 0;

  for (let index = 1; index < bearings.length; index += 1) {
    const delta = angleDeltaDeg(bearings[index - 1], bearings[index]);

    if (delta >= 155) {
      penaltyM += 380;
    } else if (delta >= 125) {
      penaltyM += 210;
    } else if (delta >= 95) {
      penaltyM += 95;
    } else if (delta >= 70) {
      penaltyM += 28;
    }
  }

  return penaltyM;
}

function toLocalMeters(point: LngLat, origin: LngLat): { x: number; y: number } {
  const phi0 = toRadians(origin[1]);

  return {
    x: toRadians(point[0] - origin[0]) * EARTH_RADIUS_M * Math.cos(phi0),
    y: toRadians(point[1] - origin[1]) * EARTH_RADIUS_M,
  };
}

function calculateRepeatedPathPenaltyM(routePolyline: LngLat[]): number {
  const routeLengthM = getPolylineLengthM(routePolyline);
  const routeSamples = samplePolylineEvenly(
    routePolyline,
    clampNumber(Math.ceil(routeLengthM / 24) + 1, 8, 180)
  );

  if (routeSamples.length < 8) return 0;

  const origin = routeSamples[0];
  const cellSizeM = 38;
  const visited = new Map<string, number>();
  let repeatedCellCount = 0;
  let longReturnCount = 0;

  routeSamples.forEach((point, index) => {
    const local = toLocalMeters(point, origin);
    const key = `${Math.round(local.x / cellSizeM)},${Math.round(local.y / cellSizeM)}`;
    const previousIndex = visited.get(key);

    if (previousIndex !== undefined && index - previousIndex > 5) {
      repeatedCellCount += 1;

      if (index - previousIndex > 14) {
        longReturnCount += 1;
      }
    } else if (previousIndex === undefined) {
      visited.set(key, index);
    }
  });

  return repeatedCellCount * 55 + longReturnCount * 120;
}

function calculateDrawProgressPenaltyM({
  routePolyline,
  drawnPoints,
  isCircular,
}: {
  routePolyline: LngLat[];
  drawnPoints: LngLat[];
  isCircular: boolean;
}): number {
  const drawnSamples = samplePolylineEvenly(drawnPoints, isCircular ? 72 : 56);
  const routeSamples = samplePolylineEvenly(routePolyline, isCircular ? 84 : 64);

  if (drawnSamples.length < 4 || routeSamples.length < 4) return 0;

  const nearestIndexes = routeSamples.map((point) =>
    getNearestSampleIndexAndDistance(point, drawnSamples).index
  );

  let penaltyM = 0;
  let previous = nearestIndexes[0];
  let wrapOffset = 0;
  const wrapThreshold = Math.max(6, Math.round(drawnSamples.length * 0.36));

  for (let index = 1; index < nearestIndexes.length; index += 1) {
    let current = nearestIndexes[index] + wrapOffset;

    if (isCircular && previous - current > wrapThreshold) {
      wrapOffset += drawnSamples.length;
      current += drawnSamples.length;
    }

    const regression = previous - current;

    if (regression > 2) {
      penaltyM += regression * (isCircular ? 28 : 38);
    }

    const jump = current - previous;
    if (jump > drawnSamples.length * 0.22) {
      penaltyM += jump * 10;
    }

    previous = current;
  }

  return penaltyM;
}

function calculateDrawCorridorMetrics({
  routePolyline,
  drawnPoints,
  isCircular,
}: {
  routePolyline: LngLat[];
  drawnPoints: LngLat[];
  isCircular: boolean;
}): {
  averageDistanceM: number;
  maxDistanceM: number;
  averageOutsideM: number;
  maxOutsideM: number;
  outsideRatio: number;
  corridorWidthM: number;
} {
  const drawnDistanceM = getPolylineLengthM(drawnPoints);
  const radiusStats = getDrawnRouteRadiusStats(drawnPoints);
  const drawnSamples = samplePolylineEvenly(drawnPoints, isCircular ? 72 : 56);
  const routeSamples = samplePolylineEvenly(routePolyline, isCircular ? 96 : 72);

  if (drawnSamples.length === 0 || routeSamples.length === 0) {
    return {
      averageDistanceM: Number.POSITIVE_INFINITY,
      maxDistanceM: Number.POSITIVE_INFINITY,
      averageOutsideM: Number.POSITIVE_INFINITY,
      maxOutsideM: Number.POSITIVE_INFINITY,
      outsideRatio: 1,
      corridorWidthM: 0,
    };
  }

  const corridorWidthM = isCircular
    ? clampNumber(radiusStats.averageRadiusM * 0.42, 85, 260)
    : clampNumber(drawnDistanceM * 0.13, 70, 240);
  const distances = routeSamples.map((point) =>
    minDistanceToPolylineSamplesM(point, drawnSamples)
  );
  const outsideDistances = distances.map((distanceM) =>
    Math.max(0, distanceM - corridorWidthM)
  );
  const averageDistanceM =
    distances.reduce((acc, value) => acc + value, 0) / distances.length;
  const averageOutsideM =
    outsideDistances.reduce((acc, value) => acc + value, 0) /
    outsideDistances.length;
  const outsideRatio =
    outsideDistances.filter((value) => value > 0).length / outsideDistances.length;

  return {
    averageDistanceM,
    maxDistanceM: Math.max(...distances),
    averageOutsideM,
    maxOutsideM: Math.max(...outsideDistances),
    outsideRatio,
    corridorWidthM,
  };
}

function calculateDrawCoverageMetrics({
  routePolyline,
  drawnPoints,
  isCircular,
}: {
  routePolyline: LngLat[];
  drawnPoints: LngLat[];
  isCircular: boolean;
}): {
  averageUncoveredM: number;
  maxUncoveredM: number;
  uncoveredRatio: number;
} {
  const drawnDistanceM = getPolylineLengthM(drawnPoints);
  const radiusStats = getDrawnRouteRadiusStats(drawnPoints);
  const drawnSamples = samplePolylineEvenly(drawnPoints, isCircular ? 96 : 84);
  const routeSamples = samplePolylineEvenly(routePolyline, isCircular ? 96 : 84);

  if (drawnSamples.length === 0 || routeSamples.length === 0) {
    return {
      averageUncoveredM: Number.POSITIVE_INFINITY,
      maxUncoveredM: Number.POSITIVE_INFINITY,
      uncoveredRatio: 1,
    };
  }

  const toleranceM = isCircular
    ? clampNumber(radiusStats.averageRadiusM * 0.34, 65, 210)
    : clampNumber(drawnDistanceM * 0.10, 55, 180);
  const distances = drawnSamples.map((point) =>
    minDistanceToPolylineSamplesM(point, routeSamples)
  );
  const uncoveredDistances = distances.map((distanceM) =>
    Math.max(0, distanceM - toleranceM)
  );

  return {
    averageUncoveredM:
      uncoveredDistances.reduce((acc, value) => acc + value, 0) /
      uncoveredDistances.length,
    maxUncoveredM: Math.max(...uncoveredDistances),
    uncoveredRatio:
      uncoveredDistances.filter((value) => value > 0).length / uncoveredDistances.length,
  };
}

function calculateLoopClosurePenaltyM({
  routePolyline,
  drawnPoints,
  isCircular,
}: {
  routePolyline: LngLat[];
  drawnPoints: LngLat[];
  isCircular: boolean;
}): number {
  const routeStart = routePolyline[0];
  const routeFinish = routePolyline[routePolyline.length - 1];
  const drawnStart = drawnPoints[0];
  const drawnFinish = drawnPoints[drawnPoints.length - 1];

  if (!routeStart || !routeFinish || !drawnStart || !drawnFinish) {
    return Number.POSITIVE_INFINITY;
  }

  if (isCircular) {
    const routeClosureM = haversineDistanceM(routeStart, routeFinish);
    const startAnchorM = haversineDistanceM(routeStart, drawnStart);
    const finishAnchorM = haversineDistanceM(routeFinish, drawnStart);

    return routeClosureM * 1.9 + startAnchorM * 0.65 + finishAnchorM * 0.80;
  }

  return (
    haversineDistanceM(routeStart, drawnStart) * 0.35 +
    haversineDistanceM(routeFinish, drawnFinish) * 0.55
  );
}

function calculateDrawRouteShapeScore({
  routePolyline,
  drawnPoints,
  distanceErrorM,
  isCircular,
}: {
  routePolyline: LngLat[];
  drawnPoints: LngLat[];
  distanceErrorM: number;
  isCircular: boolean;
}): number {
  const corridor = calculateDrawCorridorMetrics({
    routePolyline,
    drawnPoints,
    isCircular,
  });
  const coverage = calculateDrawCoverageMetrics({
    routePolyline,
    drawnPoints,
    isCircular,
  });
  const repeatedSignal = getRepeatedLoopSignal(drawnPoints);
  const repeatedPathPenaltyM = calculateRepeatedPathPenaltyM(routePolyline);
  const sharpTurnPenaltyM = calculateSharpTurnPenaltyM(routePolyline);
  const progressPenaltyM = calculateDrawProgressPenaltyM({
    routePolyline,
    drawnPoints,
    isCircular,
  });
  const closurePenaltyM = calculateLoopClosurePenaltyM({
    routePolyline,
    drawnPoints,
    isCircular,
  });
  const drawnDistanceM = Math.max(getPolylineLengthM(drawnPoints), 1);
  const routeDistanceM = Math.max(getPolylineLengthM(routePolyline), 1);
  const hasOpenLoop = hasOpenLoopGesture(drawnPoints);
  const loopLikeSketch = isCircular || hasOpenLoop || repeatedSignal.hasRepeatedArea;
  const expectedMinimumRatio = repeatedSignal.hasRepeatedArea
    ? 0.88
    : loopLikeSketch
      ? 0.76
      : 0.62;
  const shortcutDistancePenaltyM = Math.max(
    0,
    drawnDistanceM * expectedMinimumRatio - routeDistanceM
  ) * (repeatedSignal.hasRepeatedArea ? 4.8 : loopLikeSketch ? 3.2 : 1.8);
  const repeatedLoopDistancePenaltyM = repeatedSignal.hasRepeatedArea
    ? Math.max(0, drawnDistanceM - routeDistanceM) * 2.40
    : 0;

  return (
    distanceErrorM * 0.72 +
    corridor.averageDistanceM * 1.55 +
    corridor.maxDistanceM * 0.38 +
    corridor.averageOutsideM * 5.80 +
    corridor.maxOutsideM * 1.30 +
    corridor.outsideRatio * drawnDistanceM * 0.92 +
    coverage.averageUncoveredM * 4.60 +
    coverage.maxUncoveredM * 1.15 +
    coverage.uncoveredRatio * drawnDistanceM * 1.05 +
    shortcutDistancePenaltyM +
    repeatedLoopDistancePenaltyM +
    repeatedPathPenaltyM +
    sharpTurnPenaltyM +
    progressPenaltyM +
    closurePenaltyM
  );
}

function makeDrawAttemptKey(points: LngLat[]): string {
  return points
    .map((point) => `${point[0].toFixed(5)},${point[1].toFixed(5)}`)
    .join(";");
}

function makeDrawRouteCandidateKey(route: Pick<Course, "distanceM" | "polyline">): string {
  const start = route.polyline[0];
  const q1 = samplePolylineByRatio(route.polyline, 0.25);
  const middle = samplePolylineByRatio(route.polyline, 0.5);
  const q3 = samplePolylineByRatio(route.polyline, 0.75);
  const finish = route.polyline[route.polyline.length - 1];

  return [
    Math.round(route.distanceM / 15),
    start ? `${start[0].toFixed(4)},${start[1].toFixed(4)}` : "no-start",
    q1 ? `${q1[0].toFixed(4)},${q1[1].toFixed(4)}` : "no-q1",
    middle ? `${middle[0].toFixed(4)},${middle[1].toFixed(4)}` : "no-middle",
    q3 ? `${q3[0].toFixed(4)},${q3[1].toFixed(4)}` : "no-q3",
    finish ? `${finish[0].toFixed(4)},${finish[1].toFixed(4)}` : "no-finish",
  ].join("|");
}

function getDrawRouteAttempts(points: LngLat[]): LngLat[][] {
  if (points.length < 2) return [];

  const start = points[0];
  const finish = points[points.length - 1];
  const lastIndex = points.length - 1;
  const attempts: LngLat[][] = [[start, finish]];

  if (points.length >= 4) {
    attempts.push([start, points[Math.round(lastIndex * 0.5)], finish]);
  }

  if (points.length >= 7) {
    attempts.push([
      start,
      points[Math.round(lastIndex * 0.33)],
      points[Math.round(lastIndex * 0.67)],
      finish,
    ]);
  }

  if (points.length >= 10) {
    attempts.push(getDrawRouteWaypointSamples(points));
  }

  // Open loops, lollipop routes, and loop-with-tail sketches need ordered
  // waypoint attempts. Otherwise the route generator may connect the first and
  // last point by a shortcut and ignore the loop portion.
  attempts.push(...getShapePreservingWaypointAttempts(points, { closeToStart: false }));

  if (hasOpenLoopGesture(points) || getRepeatedLoopSignal(points).hasRepeatedArea) {
    attempts.unshift(...getLoopSegmentPreservingWaypointAttempts(points, { closeToStart: false }));
    attempts.push(...getShapePreservingWaypointAttempts(points, { closeToStart: false }));
  }

  const seen = new Set<string>();

  return attempts
    .map((attempt) => compactWaypointAttempt(removeConsecutiveDuplicatePoints(attempt), 32))
    .filter((attempt) => {
      if (attempt.length < 2) return false;

      const key = makeDrawAttemptKey(attempt);
      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    });
}

async function generateDrawnRouteCandidates({
  drawnPoints,
  token,
  signal,
}: {
  drawnPoints: LngLat[];
  token: string;
  signal?: AbortSignal;
}): Promise<AutoLoopCourseCandidate[]> {
  throwIfCourseSearchAborted(signal);
  if (!token) {
    throw new Error("Mapbox token이 없습니다.");
  }

  if (drawnPoints.length < 2) {
    throw new Error("지도 위에 코스 방향을 먼저 그려주세요.");
  }

  const start = drawnPoints[0];
  const finish = drawnPoints[drawnPoints.length - 1];
  const drawnDistanceM = Math.max(
    getPolylineLengthM(drawnPoints),
    haversineDistanceM(start, finish)
  );
  const isCircular = isLikelyCircularDrawnRoute(drawnPoints);
  const hasOpenLoop = !isCircular && hasOpenLoopGesture(drawnPoints);
  const repeatedSignal = getRepeatedLoopSignal(drawnPoints);
  const outAndBackLoopPattern = detectOutAndBackRepeatedLoopPattern(drawnPoints);
  const drawCandidateLabel = outAndBackLoopPattern
    ? outAndBackLoopPattern.estimatedLapCount >= 2
      ? "왕복 반복 루프"
      : "왕복 루프"
    : isCircular
      ? repeatedSignal.estimatedLapCount >= 2
        ? "반복 루프"
        : "원형"
      : hasOpenLoop
        ? "루프 포함"
        : "그리기";
  const attempts = isCircular
    ? getLoopWaypointAttempts(drawnPoints)
    : getDrawRouteAttempts(drawnPoints);
  const loopPreservingAttempts =
    outAndBackLoopPattern ||
    hasOpenLoop ||
    repeatedSignal.hasRepeatedArea ||
    repeatedSignal.estimatedLapCount >= 2
      ? getLoopSegmentPreservingWaypointAttempts(drawnPoints, {
          closeToStart: isCircular || Boolean(outAndBackLoopPattern),
        }).slice(0, 2)
      : [];
  const seenRoutes = new Set<string>();
  const scoredCandidates: Array<{
    candidate: AutoLoopCourseCandidate;
    score: number;
  }> = [];

  const addRouteCandidate = (
    route: { distanceM: number; polyline: LngLat[] },
    options: {
      scoreMultiplier?: number;
      label?: string;
      forceTopRank?: boolean;
      forceWithinTolerance?: boolean;
    } = {}
  ) => {
    const key = makeDrawRouteCandidateKey(route);
    if (seenRoutes.has(key)) return;
    seenRoutes.add(key);

    const scoreMultiplier = options.scoreMultiplier ?? 1;
    const distanceErrorM = Math.abs(route.distanceM - drawnDistanceM);
    const rawScore = calculateDrawRouteShapeScore({
      routePolyline: route.polyline,
      drawnPoints,
      distanceErrorM,
      isCircular: isCircular || Boolean(outAndBackLoopPattern),
    });
    const score = options.forceTopRank
      ? -100_000 + scoredCandidates.length
      : rawScore * scoreMultiplier;
    const label = options.label ?? drawCandidateLabel;

    scoredCandidates.push({
      candidate: {
        id: `draw-route-candidate-${scoredCandidates.length + 1}`,
        candidateId: `draw-route-candidate-${scoredCandidates.length + 1}`,
        name: `${label} 후보 ${scoredCandidates.length + 1}`,
        distanceM: route.distanceM,
        distanceErrorM,
        isWithinTolerance: options.forceWithinTolerance || (isCircular
          ? score <= Math.max(900, drawnDistanceM * 0.72)
          : score <= Math.max(650, drawnDistanceM * 0.48)),
        bearingDeg: 0,
        endpoint: isCircular || outAndBackLoopPattern ? start : finish,
        straightDistanceM: haversineDistanceM(start, finish),
        outboundDistanceM: route.distanceM,
        polyline: route.polyline,
      },
      score,
    });
  };

  if (outAndBackLoopPattern) {
    try {
      const route = await fetchOutAndBackRepeatedLoopRoute({
        pattern: outAndBackLoopPattern,
        token,
        signal,
      });
      throwIfCourseSearchAborted(signal);
      addRouteCandidate(route, {
        label: outAndBackLoopPattern.estimatedLapCount >= 2
          ? `왕복 ${outAndBackLoopPattern.estimatedLapCount}바퀴 루프`
          : "왕복 루프",
        forceTopRank: true,
        forceWithinTolerance: true,
      });
    } catch (error) {
      if (isCourseSearchAbortError(error)) {
        throw error;
      }

      console.warn("Failed to generate out-and-back repeated loop candidate:", {
        pattern: outAndBackLoopPattern,
        error,
      });
    }
  }

  for (const attempt of loopPreservingAttempts) {
    throwIfCourseSearchAborted(signal);

    try {
      const route = await fetchWalkingRouteBySegments(attempt, token, signal);
      throwIfCourseSearchAborted(signal);
      addRouteCandidate(route, { scoreMultiplier: 0.72 });
    } catch (error) {
      if (isCourseSearchAbortError(error)) {
        throw error;
      }

      console.warn("Failed to generate loop-preserving drawn route candidate:", {
        attempt,
        error,
      });
    }
  }

  for (const attempt of attempts) {
    throwIfCourseSearchAborted(signal);

    try {
      const alternatives = !isCircular && attempt.length === 2;
      const routes = await fetchWalkingRouteVariants(
        attempt,
        token,
        alternatives,
        signal
      );
      throwIfCourseSearchAborted(signal);

      routes.forEach((route) => {
        addRouteCandidate(route);
      });
    } catch (error) {
      if (isCourseSearchAbortError(error)) {
        throw error;
      }

      console.warn("Failed to generate drawn route candidate:", {
        attempt,
        error,
      });
    }
  }

  return scoredCandidates
    .sort((a, b) => {
      if (a.candidate.isWithinTolerance !== b.candidate.isWithinTolerance) {
        return a.candidate.isWithinTolerance ? -1 : 1;
      }

      return a.score - b.score;
    })
    .slice(0, MAX_ONE_WAY_CANDIDATES_TO_RETURN)
    .map(({ candidate }, index) => {
      const baseName = candidate.name.replace(/ 후보 \d+$/, "");

      return {
        ...candidate,
        id: `draw-route-candidate-${index + 1}`,
        candidateId: `draw-route-candidate-${index + 1}`,
        name: `${baseName} 후보 ${index + 1}`,
      };
    });
}

function parsePaceInput(input: string): number {
  const trimmed = input.trim();

  if (trimmed.includes(":")) {
    const [minText, secText] = trimmed.split(":");
    const minutes = Number(minText);
    const seconds = Number(secText);

    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
      return 330;
    }

    return clampPaceSecPerKm(minutes * 60 + seconds);
  }

  const asNumber = Number(trimmed);

  if (!Number.isFinite(asNumber)) {
    return 330;
  }

  return clampPaceSecPerKm(asNumber * 60);
}

function createRunnerMarkerElement(
  label: string,
  emoji: string,
  borderColor: string
) {
  const wrapper = document.createElement("div");

  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.alignItems = "center";
  wrapper.style.gap = "2px";

  const dot = document.createElement("div");
  dot.textContent = emoji;
  dot.style.width = "36px";
  dot.style.height = "36px";
  dot.style.borderRadius = "9999px";
  dot.style.background = "white";
  dot.style.display = "flex";
  dot.style.alignItems = "center";
  dot.style.justifyContent = "center";
  dot.style.boxShadow = "0 4px 12px rgba(0,0,0,0.25)";
  dot.style.border = `3px solid ${borderColor}`;
  dot.style.fontSize = "19px";

  const text = document.createElement("div");
  text.textContent = label;
  text.style.background = "rgba(15, 23, 42, 0.9)";
  text.style.color = "white";
  text.style.padding = "2px 6px";
  text.style.borderRadius = "9999px";
  text.style.fontSize = "11px";
  text.style.whiteSpace = "nowrap";

  wrapper.appendChild(dot);
  wrapper.appendChild(text);

  return wrapper;
}

function createCurrentLocationMarkerElement() {
  const wrapper = document.createElement("div");
  wrapper.style.position = "relative";
  wrapper.style.width = "34px";
  wrapper.style.height = "34px";
  wrapper.style.display = "flex";
  wrapper.style.alignItems = "center";
  wrapper.style.justifyContent = "center";

  const pulse = document.createElement("div");
  pulse.style.position = "absolute";
  pulse.style.width = "34px";
  pulse.style.height = "34px";
  pulse.style.borderRadius = "9999px";
  pulse.style.background = "rgba(37, 99, 235, 0.22)";
  pulse.style.boxShadow = "0 0 0 8px rgba(37, 99, 235, 0.10)";

  const dot = document.createElement("div");
  dot.style.position = "relative";
  dot.style.width = "16px";
  dot.style.height = "16px";
  dot.style.borderRadius = "9999px";
  dot.style.background = "#2563eb";
  dot.style.border = "3px solid white";
  dot.style.boxShadow = "0 4px 12px rgba(15, 23, 42, 0.35)";

  wrapper.appendChild(pulse);
  wrapper.appendChild(dot);

  return wrapper;
}

function createTurnaroundMarkerElement(label: string, color: string) {
  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.alignItems = "center";
  wrapper.style.gap = "2px";

  const dot = document.createElement("div");
  dot.className = "turnaround-point-dot";
  dot.textContent = "↩";
  dot.style.width = "36px";
  dot.style.height = "36px";
  dot.style.borderRadius = "9999px";
  dot.style.background = color;
  dot.style.color = "white";
  dot.style.display = "flex";
  dot.style.alignItems = "center";
  dot.style.justifyContent = "center";
  dot.style.fontSize = "18px";
  dot.style.fontWeight = "900";
  dot.style.border = "2px solid white";
  dot.style.boxShadow = "0 4px 12px rgba(15, 23, 42, 0.28)";

  const text = document.createElement("div");
  text.textContent = label;
  text.style.background = "rgba(15, 23, 42, 0.92)";
  text.style.color = "white";
  text.style.padding = "2px 7px";
  text.style.borderRadius = "9999px";
  text.style.fontSize = "11px";
  text.style.fontWeight = "800";
  text.style.whiteSpace = "nowrap";

  wrapper.appendChild(dot);
  wrapper.appendChild(text);

  return wrapper;
}

function getGpsStatusLabel(status: string): string {
  if (status === "idle") return "대기";
  if (status === "requesting") return "GPS 요청 중";
  if (status === "watching") return "GPS 수신 중";
  if (status === "error") return "GPS 오류";
  if (status === "unsupported") return "미지원";
  return status;
}

function getPositionErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "number"
  ) {
    const code = (error as { code: number }).code;

    if (code === 1) return "위치 권한이 거부되었습니다.";
    if (code === 2) return "현재 위치를 가져올 수 없습니다.";
    if (code === 3) return "현재 위치 요청 시간이 초과되었습니다.";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "현재 위치를 가져오지 못했습니다.";
}

function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("이 브라우저는 Geolocation API를 지원하지 않습니다."));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15_000,
    });
  });
}

function makeCourseGeoJson(course: Course) {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: course.polyline,
    },
  } as const;
}

function makeAutoLoopCandidateGeoJson(candidate: AutoLoopCourseCandidate | null) {
  return {
    type: "FeatureCollection",
    features: candidate
      ? [
          {
            type: "Feature",
            properties: {
              candidateId: candidate.candidateId,
            },
            geometry: {
              type: "LineString",
              coordinates: candidate.polyline,
            },
          },
        ]
      : [],
  } as GeoJSON.FeatureCollection<GeoJSON.LineString>;
}

function getAutoLoopCandidateColor(index: number): string {
  return AUTO_LOOP_COLORS[index % AUTO_LOOP_COLORS.length];
}

function getCandidateModeLabel(mode: CandidateMode): string {
  return mode === "oneWay" ? "편도" : "왕복";
}

function formatPoint(point: LngLat | null): string {
  if (!point) return "미선택";
  return `${point[1].toFixed(5)}, ${point[0].toFixed(5)}`;
}

function getCustomDraftDistanceM(
  points: CustomCoursePoints,
  routeMode: CustomRouteMode
): number | null {
  if (!points.start || !points.finish) return null;

  const oneWayDistanceM = haversineDistanceM(points.start, points.finish);

  return routeMode === "outAndBack" ? oneWayDistanceM * 2 : oneWayDistanceM;
}

function formatDraftDistance(distanceM: number | null): string {
  if (distanceM === null || !Number.isFinite(distanceM)) return "시작점과 종료지점을 선택하세요.";
  if (distanceM < 1000) return `${Math.round(distanceM)}m`;
  return `${(distanceM / 1000).toFixed(2)}km`;
}

function getCustomStepLabel(step: CustomPointStep): string {
  if (step === "start") return "시작지점";
  if (step === "turnaround") return "반환점";
  return "종료지점";
}

function getCustomPointLabel(type: CustomPointStep): string {
  if (type === "start") return "시작";
  if (type === "turnaround") return "반환";
  return "종료";
}

function getCustomPointColor(type: CustomPointStep): string {
  if (type === "start") return "#16a34a";
  if (type === "turnaround") return "#f97316";
  return "#dc2626";
}

function getNextRequiredStep(points: CustomCoursePoints): CustomPointStep {
  if (!points.start) return "start";
  if (!points.finish) return "finish";
  return "finish";
}

function getCustomGuideText(guide: CustomGuide): string {
  if (guide === "select-start") return "지도를 눌러 시작점을 선택하십시오.";
  if (guide === "add-turnaround") return "반환점을 추가하려면 반환점 추가 버튼을 누르십시오.";
  if (guide === "select-turnaround") return "지도를 눌러 반환점을 선택하십시오.";
  if (guide === "select-finish") return "지도를 눌러 종료 지점을 선택하십시오.";
  if (guide === "build-course") return "코스 생성 버튼을 눌러 코스를 생성하십시오.";
  return "";
}

function createCustomPointMarkerElement(type: CustomPointStep) {
  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.alignItems = "center";
  wrapper.style.gap = "2px";
  wrapper.style.touchAction = "none";
  wrapper.style.cursor = "grab";

  const dot = document.createElement("div");
  dot.textContent = type === "start" ? "S" : type === "turnaround" ? "T" : "F";
  dot.style.width = "34px";
  dot.style.height = "34px";
  dot.style.borderRadius = "9999px";
  dot.style.background = getCustomPointColor(type);
  dot.style.color = "white";
  dot.style.display = "flex";
  dot.style.alignItems = "center";
  dot.style.justifyContent = "center";
  dot.style.boxShadow = "0 4px 12px rgba(0,0,0,0.28)";
  dot.style.border = "2px solid white";
  dot.style.fontSize = "14px";
  dot.style.fontWeight = "800";

  const text = document.createElement("div");
  text.textContent = getCustomPointLabel(type);
  text.style.background = "rgba(15, 23, 42, 0.9)";
  text.style.color = "white";
  text.style.padding = "2px 6px";
  text.style.borderRadius = "9999px";
  text.style.fontSize = "11px";
  text.style.whiteSpace = "nowrap";

  wrapper.appendChild(dot);
  wrapper.appendChild(text);

  return wrapper;
}

function getSortedRunRecords(records: RunRecord[]): RunRecord[] {
  return [...records].sort((a, b) => b.completedAt - a.completedAt);
}

function getSortedCourseLibrary(courses: StoredCourseRecord[]): StoredCourseRecord[] {
  return [...courses].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    const aTime = a.lastCompletedAt ?? a.updatedAt ?? a.createdAt;
    const bTime = b.lastCompletedAt ?? b.updatedAt ?? b.createdAt;
    return bTime - aTime;
  });
}

function getCourseSourceLabel(source: CourseOrigin): string {
  if (source === "custom") return "저장 코스";
  if (source === "generated") return "자동 추천";
  return "기록에서 생성";
}

function validateStoredCourseRecord(value: unknown): StoredCourseRecord | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Partial<StoredCourseRecord>;
  const polyline = Array.isArray(record.polyline) ? record.polyline : null;

  if (
    typeof record.courseId !== "string" ||
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.distanceM !== "number" ||
    !polyline
  ) {
    return null;
  }

  const validPolyline = polyline.every((point) => {
    return (
      Array.isArray(point) &&
      point.length === 2 &&
      typeof point[0] === "number" &&
      typeof point[1] === "number" &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1])
    );
  });

  if (!validPolyline) return null;

  const validTurnaround =
    Array.isArray(record.turnaround) &&
    record.turnaround.length === 2 &&
    typeof record.turnaround[0] === "number" &&
    typeof record.turnaround[1] === "number" &&
    Number.isFinite(record.turnaround[0]) &&
    Number.isFinite(record.turnaround[1])
      ? ([record.turnaround[0], record.turnaround[1]] as LngLat)
      : null;

  const validCourseMode =
    record.courseMode === "outAndBack" ||
    record.courseMode === "oneWay" ||
    record.courseMode === "custom" ||
    record.courseMode === "saved"
      ? record.courseMode
      : null;

  const validSource: CourseOrigin =
    record.source === "generated" ||
    record.source === "custom" ||
    record.source === "completed-import"
      ? record.source
      : validCourseMode === "custom"
        ? "custom"
        : "generated";

  return {
    courseId: record.courseId,
    id: record.id,
    name: record.name,
    distanceM: record.distanceM,
    polyline: polyline as LngLat[],
    favorite: Boolean(record.favorite),
    source: validSource,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
    courseMode: validCourseMode ?? "saved",
    turnaround: validTurnaround,
    completionCount:
      typeof record.completionCount === "number" && Number.isFinite(record.completionCount)
        ? Math.max(0, Math.round(record.completionCount))
        : 0,
    lastCompletedAt:
      typeof record.lastCompletedAt === "number" && Number.isFinite(record.lastCompletedAt)
        ? record.lastCompletedAt
        : null,
    bestElapsedSec:
      typeof record.bestElapsedSec === "number" && Number.isFinite(record.bestElapsedSec)
        ? record.bestElapsedSec
        : null,
  };
}

function validateRunRecord(value: unknown): RunRecord | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Partial<RunRecord> & Partial<Course>;
  const polyline = Array.isArray(record.polyline) ? record.polyline : null;

  if (
    typeof record.runId !== "string" ||
    typeof record.courseId !== "string" ||
    typeof record.distanceM !== "number" ||
    !polyline
  ) {
    return null;
  }

  const validPolyline = polyline.every((point) => {
    return (
      Array.isArray(point) &&
      point.length === 2 &&
      typeof point[0] === "number" &&
      typeof point[1] === "number" &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1])
    );
  });

  if (!validPolyline) return null;

  const validTurnaround =
    Array.isArray(record.turnaround) &&
    record.turnaround.length === 2 &&
    typeof record.turnaround[0] === "number" &&
    typeof record.turnaround[1] === "number" &&
    Number.isFinite(record.turnaround[0]) &&
    Number.isFinite(record.turnaround[1])
      ? ([record.turnaround[0], record.turnaround[1]] as LngLat)
      : null;

  const validCourseMode =
    record.courseMode === "outAndBack" ||
    record.courseMode === "oneWay" ||
    record.courseMode === "custom" ||
    record.courseMode === "saved"
      ? record.courseMode
      : null;

  return {
    runId: record.runId,
    courseId: record.courseId,
    courseName:
      typeof record.courseName === "string"
        ? record.courseName
        : typeof record.name === "string"
          ? record.name
          : "완주 코스",
    distanceM: record.distanceM,
    polyline: polyline as LngLat[],
    completedAt: typeof record.completedAt === "number" ? record.completedAt : Date.now(),
    elapsedSec:
      typeof record.elapsedSec === "number" && Number.isFinite(record.elapsedSec)
        ? record.elapsedSec
        : null,
    courseMode: validCourseMode ?? "saved",
    turnaround: validTurnaround,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  };
}

function makeStoredCourseFromLegacyCustom(value: unknown): StoredCourseRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const legacy = value as Partial<Course> & {
    customId?: string;
    favorite?: boolean;
    createdAt?: number;
    updatedAt?: number;
    courseMode?: "custom";
    turnaround?: LngLat | null;
  };

  const courseId = typeof legacy.customId === "string" ? legacy.customId : undefined;
  if (!courseId) return null;

  return validateStoredCourseRecord({
    ...legacy,
    courseId,
    source: "custom",
    completionCount: 0,
    lastCompletedAt: null,
    bestElapsedSec: null,
  });
}

function makeCourseKey(course: Pick<Course, "polyline" | "distanceM">): string {
  const start = course.polyline[0];
  const finish = course.polyline[course.polyline.length - 1];
  return [
    Math.round(course.distanceM),
    start ? `${start[0].toFixed(5)},${start[1].toFixed(5)}` : "no-start",
    finish ? `${finish[0].toFixed(5)},${finish[1].toFixed(5)}` : "no-finish",
  ].join("|");
}

function makeLegacyRunMigration(rawLegacyRuns: unknown): {
  migratedCourses: StoredCourseRecord[];
  migratedRuns: RunRecord[];
} {
  if (!Array.isArray(rawLegacyRuns)) {
    return { migratedCourses: [], migratedRuns: [] };
  }

  const courseByKey = new Map<string, StoredCourseRecord>();
  const migratedRuns: RunRecord[] = [];

  rawLegacyRuns.forEach((value, index) => {
    if (typeof value !== "object" || value === null) return;
    const legacy = value as Partial<Course> & {
      savedId?: string;
      favorite?: boolean;
      completedAt?: number;
      elapsedSec?: number | null;
      courseMode?: CandidateMode | "custom" | "saved" | null;
      turnaround?: LngLat | null;
      updatedAt?: number;
    };

    if (
      typeof legacy.savedId !== "string" ||
      typeof legacy.name !== "string" ||
      typeof legacy.distanceM !== "number" ||
      !Array.isArray(legacy.polyline)
    ) {
      return;
    }

    const completedAt = typeof legacy.completedAt === "number" ? legacy.completedAt : Date.now() - index;
    const key = makeCourseKey({ distanceM: legacy.distanceM, polyline: legacy.polyline as LngLat[] });
    let storedCourse = courseByKey.get(key);

    if (!storedCourse) {
      const source: CourseOrigin = legacy.courseMode === "custom" ? "custom" : "completed-import";
      storedCourse = validateStoredCourseRecord({
        id: `course-origin-${legacy.savedId}`,
        courseId: `course-origin-${legacy.savedId}`,
        name: legacy.name,
        distanceM: legacy.distanceM,
        polyline: legacy.polyline,
        favorite: Boolean(legacy.favorite),
        source,
        createdAt: completedAt,
        updatedAt: typeof legacy.updatedAt === "number" ? legacy.updatedAt : completedAt,
        courseMode: legacy.courseMode ?? "saved",
        turnaround: legacy.turnaround ?? null,
        completionCount: 0,
        lastCompletedAt: null,
        bestElapsedSec: null,
      }) ?? undefined;

      if (!storedCourse) return;
      courseByKey.set(key, storedCourse);
    }

    const run = validateRunRecord({
      runId: legacy.savedId,
      courseId: storedCourse.courseId,
      courseName: legacy.name,
      distanceM: legacy.distanceM,
      polyline: legacy.polyline,
      completedAt,
      elapsedSec: legacy.elapsedSec ?? null,
      courseMode: legacy.courseMode ?? "saved",
      turnaround: legacy.turnaround ?? null,
      updatedAt: typeof legacy.updatedAt === "number" ? legacy.updatedAt : completedAt,
    });

    if (run) migratedRuns.push(run);

    storedCourse.completionCount += 1;
    storedCourse.lastCompletedAt = Math.max(storedCourse.lastCompletedAt ?? 0, completedAt);
    if (run?.elapsedSec !== null && run?.elapsedSec !== undefined) {
      storedCourse.bestElapsedSec =
        storedCourse.bestElapsedSec === null
          ? run.elapsedSec
          : Math.min(storedCourse.bestElapsedSec, run.elapsedSec);
    }
    storedCourse.updatedAt = Date.now();
  });

  return {
    migratedCourses: Array.from(courseByKey.values()),
    migratedRuns,
  };
}

function getRouteSamplePoints(polyline: LngLat[], sampleCount: number): LngLat[] {
  const distanceM = getPolylineLengthM(polyline);

  if (polyline.length === 0) return [];
  if (polyline.length === 1 || distanceM <= 0) return [polyline[0]];

  const count = Math.max(sampleCount, 2);

  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1);
    return getLngLatAtDistance(polyline, distanceM * ratio);
  });
}

function summarizeElevations(values: number[]): ElevationSummary {
  const valid = values.filter((value) => Number.isFinite(value));

  if (valid.length < 3) {
    return { status: "unavailable" };
  }

  let gainM = 0;
  let lossM = 0;

  for (let i = 1; i < valid.length; i += 1) {
    const delta = valid[i] - valid[i - 1];

    if (Math.abs(delta) < 1) continue;

    if (delta > 0) {
      gainM += delta;
    } else {
      lossM += Math.abs(delta);
    }
  }

  return {
    status: "ready",
    minM: Math.min(...valid),
    maxM: Math.max(...valid),
    startM: valid[0],
    endM: valid[valid.length - 1],
    gainM,
    lossM,
    samples: valid.length,
  };
}

function formatElevationSummary(summary: ElevationSummary | undefined): string {
  if (!summary || summary.status === "loading") {
    return "고도 계산 중...";
  }

  if (summary.status === "unavailable") {
    return "고도 정보 부족";
  }

  return `상승 +${Math.round(summary.gainM)}m · 하강 -${Math.round(
    summary.lossM
  )}m · 고도 ${Math.round(summary.minM)}~${Math.round(summary.maxM)}m`;
}

function formatCompletedDate(timestamp: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(new Date(timestamp));
}

function formatCompletedTime(timestamp: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "기록 없음";

  const totalSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const restSeconds = totalSeconds % 60;

  return `${minutes}분 ${restSeconds.toString().padStart(2, "0")}초`;
}

function getRunRecordModeLabel(mode: RunRecord["courseMode"]): string {
  if (mode === "outAndBack") return "왕복";
  if (mode === "oneWay") return "편도";
  if (mode === "custom") return "커스텀";
  return "저장 코스";
}

function getStoredCourseModeLabel(mode: StoredCourseRecord["courseMode"]): string {
  if (mode === "outAndBack") return "왕복";
  if (mode === "oneWay") return "편도";
  if (mode === "custom") return "커스텀";
  return "저장 코스";
}

function groupRunRecordsByDate(records: RunRecord[]): Array<{
  dateLabel: string;
  records: RunRecord[];
}> {
  const groups: Array<{ dateLabel: string; records: RunRecord[] }> = [];

  records.forEach((record) => {
    const dateLabel = formatCompletedDate(record.completedAt);
    const existing = groups.find((group) => group.dateLabel === dateLabel);

    if (existing) {
      existing.records.push(record);
    } else {
      groups.push({ dateLabel, records: [record] });
    }
  });

  return groups;
}



function SetupLiquidShaderCanvas({ isActive }: { isActive: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!isActive) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });

    if (!gl) return;

    const vertexSource = `
      attribute vec2 a_position;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    const fragmentSource = `
      precision mediump float;

      uniform vec2 u_resolution;
      uniform float u_time;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) +
          (c - a) * u.y * (1.0 - u.x) +
          (d - b) * u.x * u.y;
      }

      float fbm(vec2 p) {
        float value = 0.0;
        float amp = 0.5;
        for (int i = 0; i < 5; i++) {
          value += amp * noise(p);
          p *= 2.02;
          amp *= 0.52;
        }
        return value;
      }

      float sdRoundBox(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + r;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }

      float lensAlpha(float d) {
        return 1.0 - smoothstep(0.0, 0.018, d);
      }

      float rim(float d, float width) {
        return 1.0 - smoothstep(width, width * 2.4, abs(d));
      }

      vec3 addLens(vec3 color, vec2 uv, vec2 center, vec2 size, float radius, float strength) {
        vec2 p = uv - center;
        float d = sdRoundBox(p, size, radius);
        float a = lensAlpha(d);
        float edge = rim(d, 0.006);
        float inner = 1.0 - smoothstep(-0.10, 0.018, d);
        float n = fbm((uv + center) * 8.0 + vec2(u_time * 0.018, -u_time * 0.014));
        float highlight = smoothstep(
          0.58,
          1.0,
          1.0 - length((p + vec2(size.x * 0.42, size.y * 0.46)) / max(size, vec2(0.001)))
        );

        vec3 refracted = color;
        refracted += vec3(0.036) * n * strength * a;
        refracted += vec3(0.155) * highlight * a * strength;
        refracted += vec3(0.220) * edge * strength;
        refracted -= vec3(0.026) * inner * a;

        return mix(color, refracted, a * 0.74);
      }

      void main() {
        vec2 frag = gl_FragCoord.xy;
        vec2 st = frag / u_resolution;
        vec2 uv = st;
        float aspect = u_resolution.x / max(u_resolution.y, 1.0);
        vec2 p = (st - 0.5) * vec2(aspect, 1.0);

        float t = u_time * 0.030;
        vec2 flow = vec2(
          fbm(p * 1.85 + vec2(t * 1.30, 1.8)),
          fbm(p * 1.70 + vec2(-1.2, t * 1.10))
        ) - 0.5;
        uv += flow * 0.010;

        vec3 top = vec3(0.990, 0.992, 0.996);
        vec3 bottom = vec3(0.962, 0.970, 0.982);
        vec3 color = mix(top, bottom, smoothstep(0.0, 1.0, uv.y));

        float cloud1 = smoothstep(0.78, 0.0, length((uv - vec2(0.18, 0.16)) / vec2(0.40, 0.28)));
        float cloud2 = smoothstep(0.72, 0.0, length((uv - vec2(0.86, 0.20)) / vec2(0.38, 0.30)));
        float cloud3 = smoothstep(0.70, 0.0, length((uv - vec2(0.55, 0.86)) / vec2(0.48, 0.30)));
        color = mix(color, vec3(1.0), cloud1 * 0.18);
        color = mix(color, vec3(0.940, 0.948, 0.962), cloud2 * 0.16);
        color = mix(color, vec3(0.982, 0.986, 0.992), cloud3 * 0.14);

        float warp = fbm(p * 2.2 + vec2(t, -t * 0.8));
        float caustic = pow(abs(sin((p.x + warp * 0.20) * 14.0 + cos(p.y * 7.0 + t * 5.0))), 34.0);
        color += vec3(0.028) * caustic;

        color = addLens(color, uv, vec2(0.20, 0.24), vec2(0.20, 0.070), 0.052, 0.44);
        color = addLens(color, uv, vec2(0.68, 0.28), vec2(0.30, 0.098), 0.066, 0.38);
        color = addLens(color, uv, vec2(0.72, 0.58), vec2(0.22, 0.116), 0.084, 0.34);
        color = addLens(color, uv, vec2(0.30, 0.76), vec2(0.19, 0.090), 0.064, 0.30);

        float vignette = smoothstep(1.05, 0.20, length(p));
        color = mix(vec3(0.930, 0.936, 0.946), color, vignette);
        color += vec3(0.008) * (noise(frag * 0.50 + u_time) - 0.5);

        gl_FragColor = vec4(color, 0.62);
      }
    `;

    const createShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn("Liquid shader compile error", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertexShader = createShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = createShader(gl.FRAGMENT_SHADER, fragmentSource);

    if (!vertexShader || !fragmentShader) return;

    const program = gl.createProgram();
    if (!program) return;

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn("Liquid shader link error", gl.getProgramInfoLog(program));
      return;
    }

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const positionLocation = gl.getAttribLocation(program, "a_position");
    const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
    const timeLocation = gl.getUniformLocation(program, "u_time");

    let frameId: number | null = null;
    const start = performance.now();

    const resize = () => {
      const parent = canvas.parentElement ?? document.body;
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }

      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const render = (now: number) => {
      resize();
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform1f(timeLocation, (now - start) / 1000);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      frameId = window.requestAnimationFrame(render);
    };

    frameId = window.requestAnimationFrame(render);
    window.addEventListener("resize", resize);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      window.removeEventListener("resize", resize);
      gl.deleteBuffer(positionBuffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, [isActive]);

  if (!isActive) return null;

  return (
    <canvas
      ref={canvasRef}
      className="setup-liquid-shader-canvas"
      aria-hidden="true"
    />
  );
}

export default function RaceMap() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  const startMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const finishMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const playerMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const currentLocationMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const mapLocationWatchIdRef = useRef<number | null>(null);
  const activeTurnaroundMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const previewTurnaroundMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const botMarkerRefs = useRef<Record<string, mapboxgl.Marker>>({});
  const customPointMarkerRefs = useRef<
    Partial<Record<CustomPointStep, mapboxgl.Marker>>
  >({});

  const animationFrameRef = useRef<number | null>(null);
  const lastHudUpdateRef = useRef<number>(0);
  const latestGpsProjectionRef = useRef<LatestGpsProjection | null>(null);
  const elevationRunIdRef = useRef(0);
  const completionRecordedForRunRef = useRef(false);
  const courseSearchAbortControllerRef = useRef<AbortController | null>(null);
  const courseSearchRunIdRef = useRef(0);
  const drawRoutePointerRef = useRef<{
    pointerId: number;
    hasMoved: boolean;
  } | null>(null);
  const drawRouteActivePointersRef = useRef<
    Map<number, { clientX: number; clientY: number }>
  >(new Map());
  const drawRoutePinchRef = useRef<{
    startDistancePx: number;
    startZoom: number;
  } | null>(null);
  const drawnRoutePointsRef = useRef<LngLat[]>([]);
  const bottomSheetDragRef = useRef<{
    sheet: BottomSheetKind;
    startY: number;
    lastY: number;
    startCollapsed: boolean;
  } | null>(null);
  const bottomSheetSuppressTapRef = useRef(false);

  const [activePanel, setActivePanel] = useState<ActivePanel>("setup");
  const [setupView, setSetupView] = useState<SetupView>("main");
  const [isLeaderboardOpen, setIsLeaderboardOpen] = useState(true);
  const [isAutoLoopPanelCollapsed, setIsAutoLoopPanelCollapsed] = useState(false);
  const [isCustomPanelCollapsed, setIsCustomPanelCollapsed] = useState(false);
  const [bottomSheetDragOffsetY, setBottomSheetDragOffsetY] = useState<
    Record<BottomSheetKind, number>
  >({
    candidate: 0,
    mapHud: 0,
    custom: 0,
    draw: 0,
  });
  const [draggingSheet, setDraggingSheet] = useState<BottomSheetKind | null>(
    null
  );
  const [isRunSettingsOpen, setIsRunSettingsOpen] = useState(false);
  const [isTestPanelEnabled, setIsTestPanelEnabled] = useState(false);

  const [activeCourse, setActiveCourse] = useState<Course>(DEFAULT_COURSE);
  const [activeCourseMode, setActiveCourseMode] = useState<CandidateMode | "custom" | "saved" | null>(null);
  const [activeCourseTurnaround, setActiveCourseTurnaround] = useState<LngLat | null>(null);
  const [activeCourseOriginId, setActiveCourseOriginId] = useState<string | null>(null);
  const [candidateMode, setCandidateMode] = useState<CandidateMode>("outAndBack");

  const [runRecords, setRunRecords] = useState<RunRecord[]>([]);
  const [hasLoadedRunRecords, setHasLoadedRunRecords] = useState(false);
  const [courseLibrary, setCourseLibrary] = useState<StoredCourseRecord[]>([]);
  const [hasLoadedCourseLibrary, setHasLoadedCourseLibrary] = useState(false);

  const [status, setStatus] = useState("코스를 선택해 주세요.");
  const [error, setError] = useState<string | null>(null);
  const [gpsActionError, setGpsActionError] = useState<string | null>(null);
  const [currentMapLocation, setCurrentMapLocation] = useState<LngLat | null>(null);
  const [currentMapLocationAccuracyM, setCurrentMapLocationAccuracyM] = useState<
    number | null
  >(null);
  const [mapLocationError, setMapLocationError] = useState<string | null>(null);
  const [isCenteringOnCurrentLocation, setIsCenteringOnCurrentLocation] =
    useState(false);

  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [isGeneratingCustomCourse, setIsGeneratingCustomCourse] =
    useState(false);
  const [isGeneratingAutoLoop, setIsGeneratingAutoLoop] = useState(false);
  const [isGeneratingOneWay, setIsGeneratingOneWay] = useState(false);
  const [autoLoopTargetKm, setAutoLoopTargetKm] = useState("3.0");
  const [isTargetDistanceHintVisible, setIsTargetDistanceHintVisible] =
    useState(false);
  const [autoLoopAllCandidates, setAutoLoopAllCandidates] = useState<
    AutoLoopCourseCandidate[]
  >([]);
  const [autoLoopCandidates, setAutoLoopCandidates] = useState<
    AutoLoopCourseCandidate[]
  >([]);
  const [autoLoopCandidateCursor, setAutoLoopCandidateCursor] = useState(0);
  const [autoLoopPreviewCandidateId, setAutoLoopPreviewCandidateId] =
    useState<string | null>(null);
  const [autoLoopElevationSummaries, setAutoLoopElevationSummaries] = useState<
    Record<string, ElevationSummary>
  >({});
  const [autoLoopError, setAutoLoopError] = useState<string | null>(null);

  const [isRunning, setIsRunning] = useState(false);
  const [startTimeMs, setStartTimeMs] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const [playerName, setPlayerName] = useState("Me");
  const [paceInput, setPaceInput] = useState("5:30");
  const [playerMode, setPlayerMode] = useState<PlayerMode>("gps");

  const [selectedBotIds, setSelectedBotIds] = useState<string[]>(
    INITIAL_SELECTED_BOT_IDS
  );

  const [isCustomCourseMode, setIsCustomCourseMode] = useState(false);
  const [customPointStep, setCustomPointStep] =
    useState<CustomPointStep>("start");
  const [customGuide, setCustomGuide] = useState<CustomGuide>(null);
  const [customPoints, setCustomPoints] =
    useState<CustomCoursePoints>(INITIAL_CUSTOM_POINTS);
  const [customCourseError, setCustomCourseError] = useState<string | null>(
    null
  );
  const [shouldSaveCustomCourse, setShouldSaveCustomCourse] = useState(true);
  const [customCourseName, setCustomCourseName] = useState("");
  const [customRouteMode, setCustomRouteMode] =
    useState<CustomRouteMode>("oneWay");

  const [isDrawRouteMode, setIsDrawRouteMode] = useState(false);
  const [isDrawPanelCollapsed, setIsDrawPanelCollapsed] = useState(false);
  const [drawRouteInteractionMode, setDrawRouteInteractionMode] =
    useState<DrawRouteInteractionMode>("draw");
  const [drawnRoutePoints, setDrawnRoutePoints] = useState<LngLat[]>([]);
  const [isDrawingRoute, setIsDrawingRoute] = useState(false);
  const [isGeneratingDrawRouteCandidates, setIsGeneratingDrawRouteCandidates] =
    useState(false);
  const [drawRouteError, setDrawRouteError] = useState<string | null>(null);

  const [runnerHud, setRunnerHud] = useState<RunnerHudState[]>([]);
  const [isSecureContextState, setIsSecureContextState] = useState<
    boolean | null
  >(null);

  const gpsTracker = useGpsTracker(activeCourse.polyline);

  const courseLengthM = useMemo(() => {
    return getPolylineLengthM(activeCourse.polyline);
  }, [activeCourse]);

  const hasActiveCourse = useMemo(() => {
    return isRunnableCourse(activeCourse);
  }, [activeCourse]);

  const playerPaceSecPerKm = useMemo(() => {
    return parsePaceInput(paceInput);
  }, [paceInput]);

  const selectedBots = useMemo(() => {
    return DEFAULT_BOTS.filter((bot) => selectedBotIds.includes(bot.id));
  }, [selectedBotIds]);

  const sortedRunRecords = useMemo(() => {
    return getSortedRunRecords(runRecords);
  }, [runRecords]);

  const sortedCourseLibrary = useMemo(() => {
    return getSortedCourseLibrary(courseLibrary);
  }, [courseLibrary]);

  const favoriteCourseLibrary = useMemo(() => {
    return sortedCourseLibrary.filter((course) => course.favorite);
  }, [sortedCourseLibrary]);

  const runRecordGroups = useMemo(() => {
    return groupRunRecordsByDate(sortedRunRecords);
  }, [sortedRunRecords]);

  const previewingAutoLoopCandidate = useMemo(() => {
    return (
      autoLoopCandidates.find(
        (candidate) => candidate.candidateId === autoLoopPreviewCandidateId
      ) ?? null
    );
  }, [autoLoopCandidates, autoLoopPreviewCandidateId]);

  const canBuildCustomCourse =
    Boolean(customPoints.start) &&
    Boolean(customPoints.finish) &&
    !isGeneratingCustomCourse;

  const customDraftDistanceM = useMemo(() => {
    return getCustomDraftDistanceM(customPoints, customRouteMode);
  }, [customPoints, customRouteMode]);

  const drawnRouteDistanceM = useMemo(() => {
    if (drawnRoutePoints.length < 2) return null;
    return getPolylineLengthM(drawnRoutePoints);
  }, [drawnRoutePoints]);

  const isGeneratingAnyCourse =
    isGeneratingAutoLoop || isGeneratingOneWay || isGeneratingDrawRouteCandidates;

  const isAutoLoopPanelVisible =
    isGeneratingAutoLoop ||
    isGeneratingOneWay ||
    autoLoopCandidates.length > 0 ||
    autoLoopError !== null;

  const isGeneratedCourseSearchModeActive = isAutoLoopPanelVisible;
  const isManualCourseModeActive = isCustomCourseMode || isDrawRouteMode;
  const isGeneratedCourseControlsDisabled =
    isRunning || isGeneratingAnyCourse || isManualCourseModeActive;
  const isCustomCourseStartDisabled =
    isRunning ||
    isGeneratingAnyCourse ||
    isGeneratedCourseSearchModeActive ||
    isDrawRouteMode;
  const isDrawRouteStartDisabled =
    isRunning ||
    isGeneratingAnyCourse ||
    isGeneratedCourseSearchModeActive ||
    isCustomCourseMode;

  const autoLoopRemainingCount = Math.max(
    autoLoopAllCandidates.length - autoLoopCandidateCursor,
    0
  );

  function createInitialHud(): RunnerHudState[] {
    if (!hasActiveCourse) {
      return [];
    }

    return [
      {
        id: "player",
        name: playerName || "Me",
        type: "player",
        paceSecPerKm: playerPaceSecPerKm,
        distanceM: 0,
        progressPercent: 0,
        finished: false,
      },
      ...selectedBots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        type: "bot" as const,
        paceSecPerKm: bot.paceSecPerKm,
        distanceM: 0,
        progressPercent: 0,
        finished: false,
      })),
    ];
  }

  function enableTerrainElevationSource(map: mapboxgl.Map) {
    const terrainMap = map as TerrainQueryableMap;

    if (!map.getSource("mapbox-dem")) {
      map.addSource("mapbox-dem", {
        type: "raster-dem",
        url: "mapbox://mapbox.mapbox-terrain-dem-v1",
        tileSize: 512,
        maxzoom: 14,
      } as never);
    }

    terrainMap.setTerrain?.({
      source: "mapbox-dem",
      exaggeration: 1,
    });
  }

  function startMapLocationWatch() {
    if (!("geolocation" in navigator)) {
      setMapLocationError("이 브라우저는 위치 기능을 지원하지 않습니다.");
      return;
    }

    if (mapLocationWatchIdRef.current !== null) return;

    setMapLocationError(null);

    mapLocationWatchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const nextLocation: LngLat = [
          position.coords.longitude,
          position.coords.latitude,
        ];

        setCurrentMapLocation(nextLocation);
        setCurrentMapLocationAccuracyM(position.coords.accuracy);
        setMapLocationError(null);
      },
      (positionError) => {
        setMapLocationError(getPositionErrorMessage(positionError));
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15_000,
      }
    );
  }

  function stopMapLocationWatch() {
    if (
      "geolocation" in navigator &&
      mapLocationWatchIdRef.current !== null
    ) {
      navigator.geolocation.clearWatch(mapLocationWatchIdRef.current);
    }

    mapLocationWatchIdRef.current = null;
  }

  async function handleCenterMapOnCurrentLocation() {
    if (isSecureContextState === false) {
      setMapLocationError("현재 위치 기능은 HTTPS 환경 또는 localhost에서 사용해야 합니다.");
      return;
    }

    if (!("geolocation" in navigator)) {
      setMapLocationError("이 브라우저는 위치 기능을 지원하지 않습니다.");
      return;
    }

    try {
      setIsCenteringOnCurrentLocation(true);
      setMapLocationError(null);

      const position = await getCurrentPosition();
      const nextLocation: LngLat = [
        position.coords.longitude,
        position.coords.latitude,
      ];

      setCurrentMapLocation(nextLocation);
      setCurrentMapLocationAccuracyM(position.coords.accuracy);

      currentLocationMarkerRef.current?.setLngLat(nextLocation);
      currentLocationMarkerRef.current?.getElement().style.setProperty(
        "display",
        "flex"
      );

      mapRef.current?.flyTo({
        center: nextLocation,
        zoom: 16,
        duration: 700,
      });

      setStatus("현재 위치로 지도를 이동했습니다.");
      startMapLocationWatch();
    } catch (rawError) {
      const message = getPositionErrorMessage(rawError);
      setMapLocationError(message);
      setStatus("현재 위치 이동 실패");
    } finally {
      setIsCenteringOnCurrentLocation(false);
    }
  }

  async function handleUseCurrentLocationAsCustomStart() {
    if (isRunning || isGeneratingCustomCourse) return;

    if (isSecureContextState === false) {
      const message = "현재 위치 기능은 HTTPS 환경 또는 localhost에서 사용해야 합니다.";
      setCustomCourseError(message);
      setMapLocationError(message);
      setStatus("현재 위치 시작점 설정 실패");
      return;
    }

    if (!("geolocation" in navigator)) {
      const message = "이 브라우저는 위치 기능을 지원하지 않습니다.";
      setCustomCourseError(message);
      setMapLocationError(message);
      setStatus("현재 위치 시작점 설정 실패");
      return;
    }

    try {
      setIsCenteringOnCurrentLocation(true);
      setCustomCourseError(null);
      setMapLocationError(null);
      setStatus("현재 위치를 시작지점으로 설정하는 중...");

      const position = await getCurrentPosition();
      const nextLocation: LngLat = [
        position.coords.longitude,
        position.coords.latitude,
      ];

      setCurrentMapLocation(nextLocation);
      setCurrentMapLocationAccuracyM(position.coords.accuracy);

      currentLocationMarkerRef.current?.setLngLat(nextLocation);
      currentLocationMarkerRef.current?.getElement().style.setProperty(
        "display",
        "flex"
      );

      mapRef.current?.flyTo({
        center: nextLocation,
        zoom: 16,
        duration: 700,
      });

      selectCustomPoint("start", nextLocation);
      startMapLocationWatch();
      setStatus("현재 위치를 시작지점으로 설정했습니다. 종료지점을 선택하세요.");
    } catch (rawError) {
      const message = getPositionErrorMessage(rawError);
      setCustomCourseError(message);
      setMapLocationError(message);
      setStatus("현재 위치 시작점 설정 실패");
    } finally {
      setIsCenteringOnCurrentLocation(false);
    }
  }

  function fitMapToCourse(course: Course) {
    const map = mapRef.current;
    if (!map || !isRunnableCourse(course)) return;

    const bounds = new mapboxgl.LngLatBounds();
    course.polyline.forEach((coord) => bounds.extend(coord));

    map.fitBounds(bounds, {
      padding: 80,
      duration: 800,
    });
  }

  function fitMapToAutoLoopCandidate(candidate: AutoLoopCourseCandidate) {
    const map = mapRef.current;
    if (!map || candidate.polyline.length === 0) return;

    const bounds = new mapboxgl.LngLatBounds();

    candidate.polyline.forEach((coord) => bounds.extend(coord));

    map.fitBounds(bounds, {
      padding: 90,
      duration: 800,
    });
  }

  function updateCourseSource(course: Course) {
    const map = mapRef.current;
    if (!map || !isRunnableCourse(course)) return;

    const data = makeCourseGeoJson(course);

    const source = map.getSource("race-course") as
      | mapboxgl.GeoJSONSource
      | undefined;

    if (source) {
      source.setData(data as GeoJSON.Feature<GeoJSON.LineString>);
    } else {
      map.addSource("race-course", {
        type: "geojson",
        data,
      });

      map.addLayer({
        id: "race-course-line",
        type: "line",
        source: "race-course",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-width": 5,
          "line-color": "#2563eb",
        },
      });
    }
  }

  function updatePreviewTurnaroundMarker(point: LngLat | null, color: string) {
    const map = mapRef.current;

    if (!map || !point) {
      previewTurnaroundMarkerRef.current?.getElement().style.setProperty(
        "display",
        "none"
      );
      return;
    }

    if (!previewTurnaroundMarkerRef.current) {
      previewTurnaroundMarkerRef.current = new mapboxgl.Marker({
        element: createTurnaroundMarkerElement("반환점", color),
        anchor: "bottom",
      })
        .setLngLat(point)
        .setPopup(new mapboxgl.Popup().setText("왕복 코스 반환점"))
        .addTo(map);
    } else {
      previewTurnaroundMarkerRef.current.setLngLat(point);
      previewTurnaroundMarkerRef.current
        .getElement()
        .style.setProperty("display", "flex");

      const dot =
        previewTurnaroundMarkerRef.current.getElement().querySelector(
          ".turnaround-point-dot"
        ) as HTMLDivElement | null;

      if (dot) {
        dot.style.background = color;
      }
    }
  }

  function updateActiveTurnaroundMarker(point: LngLat | null) {
    const map = mapRef.current;

    if (!map || !point) {
      activeTurnaroundMarkerRef.current?.getElement().style.setProperty(
        "display",
        "none"
      );
      return;
    }

    if (!activeTurnaroundMarkerRef.current) {
      activeTurnaroundMarkerRef.current = new mapboxgl.Marker({
        element: createTurnaroundMarkerElement("반환점", "#f97316"),
        anchor: "bottom",
      })
        .setLngLat(point)
        .setPopup(new mapboxgl.Popup().setText("왕복 코스 반환점"))
        .addTo(map);
    } else {
      activeTurnaroundMarkerRef.current.setLngLat(point);
      activeTurnaroundMarkerRef.current
        .getElement()
        .style.setProperty("display", "flex");
    }
  }

  function updateAutoLoopCandidateOverlay(
    candidate: AutoLoopCourseCandidate | null,
    color: string,
    mode: CandidateMode
  ) {
    const map = mapRef.current;
    if (!map) return;

    const data = makeAutoLoopCandidateGeoJson(candidate);

    const source = map.getSource("auto-loop-candidates") as
      | mapboxgl.GeoJSONSource
      | undefined;

    if (source) {
      source.setData(data);
    } else {
      map.addSource("auto-loop-candidates", {
        type: "geojson",
        data,
      });
    }

    if (!map.getLayer("auto-loop-candidates-line")) {
      map.addLayer({
        id: "auto-loop-candidates-line",
        type: "line",
        source: "auto-loop-candidates",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-width": 7,
          "line-opacity": 0.88,
          "line-color": color,
        },
      });
    } else {
      map.setPaintProperty("auto-loop-candidates-line", "line-color", color);
      map.setPaintProperty("auto-loop-candidates-line", "line-opacity", 0.88);
    }

    updatePreviewTurnaroundMarker(
      mode === "outAndBack" && candidate ? candidate.endpoint : null,
      color
    );
  }

  function clearAutoLoopCandidateOverlay() {
    const map = mapRef.current;
    if (!map) return;

    const source = map.getSource("auto-loop-candidates") as
      | mapboxgl.GeoJSONSource
      | undefined;

    if (source) {
      source.setData(makeAutoLoopCandidateGeoJson(null));
    }

    previewTurnaroundMarkerRef.current?.getElement().style.setProperty(
      "display",
      "none"
    );
  }

  function clearAutoLoopCandidates() {
    elevationRunIdRef.current += 1;
    setAutoLoopAllCandidates([]);
    setAutoLoopCandidates([]);
    setAutoLoopCandidateCursor(0);
    setAutoLoopPreviewCandidateId(null);
    setAutoLoopElevationSummaries({});
    setAutoLoopError(null);
    setIsAutoLoopPanelCollapsed(false);
    clearAutoLoopCandidateOverlay();
  }

  function beginCourseSearch() {
    courseSearchAbortControllerRef.current?.abort();

    const controller = new AbortController();
    courseSearchAbortControllerRef.current = controller;
    courseSearchRunIdRef.current += 1;

    return {
      runId: courseSearchRunIdRef.current,
      signal: controller.signal,
    };
  }

  function isCurrentCourseSearch(runId: number, signal?: AbortSignal): boolean {
    return courseSearchRunIdRef.current === runId && !signal?.aborted;
  }

  function finishCourseSearch(runId: number) {
    if (courseSearchRunIdRef.current === runId) {
      courseSearchAbortControllerRef.current = null;
    }
  }

  function handleStopCourseSearch() {
    if (!isGeneratingAutoLoop && !isGeneratingOneWay && !isGeneratingDrawRouteCandidates) {
      return;
    }

    courseSearchAbortControllerRef.current?.abort();
    courseSearchAbortControllerRef.current = null;
    courseSearchRunIdRef.current += 1;

    setIsGeneratingAutoLoop(false);
    setIsGeneratingOneWay(false);
    setIsGeneratingDrawRouteCandidates(false);
    setAutoLoopError(null);
    setDrawRouteError(null);
    setStatus("코스 탐색을 중지했습니다.");
  }

  function computeElevationSummariesForCandidates(
    candidates: AutoLoopCourseCandidate[]
  ) {
    const map = mapRef.current as TerrainQueryableMap | null;

    if (!map) return;

    const runId = elevationRunIdRef.current + 1;
    elevationRunIdRef.current = runId;

    setAutoLoopElevationSummaries((current) => {
      const next = { ...current };

      candidates.forEach((candidate) => {
        next[candidate.candidateId] = { status: "loading" };
      });

      return next;
    });

    let hasRun = false;

    const run = () => {
      if (hasRun) return;
      hasRun = true;

      if (elevationRunIdRef.current !== runId) return;

      const queryMap = mapRef.current as TerrainQueryableMap | null;

      if (!queryMap?.queryTerrainElevation) {
        setAutoLoopElevationSummaries((current) => {
          const next = { ...current };

          candidates.forEach((candidate) => {
            next[candidate.candidateId] = { status: "unavailable" };
          });

          return next;
        });

        return;
      }

      const nextSummaries: Record<string, ElevationSummary> = {};

      candidates.forEach((candidate) => {
        const samplePoints = getRouteSamplePoints(candidate.polyline, 36);
        const elevations = samplePoints
          .map((point) => {
            const value = queryMap.queryTerrainElevation?.(point, {
              exaggerated: false,
            });

            return typeof value === "number" ? value : NaN;
          })
          .filter((value) => Number.isFinite(value));

        nextSummaries[candidate.candidateId] = summarizeElevations(elevations);
      });

      if (elevationRunIdRef.current !== runId) return;

      setAutoLoopElevationSummaries((current) => ({
        ...current,
        ...nextSummaries,
      }));
    };

    map.once("idle", () => {
      window.setTimeout(run, 0);
    });

    window.setTimeout(run, 2200);
  }

  function previewAutoLoopCandidate(
    candidate: AutoLoopCourseCandidate,
    pageIndex: number,
    shouldFit = true,
    mode: CandidateMode = candidateMode
  ) {
    const color = getAutoLoopCandidateColor(pageIndex);

    setAutoLoopPreviewCandidateId(candidate.candidateId);
    updateAutoLoopCandidateOverlay(candidate, color, mode);

    if (shouldFit) {
      fitMapToAutoLoopCandidate(candidate);
    }
  }

  function showAutoLoopCandidatePage(
    allCandidates: AutoLoopCourseCandidate[],
    startIndex: number,
    mode: CandidateMode = candidateMode
  ) {
    const nextCandidates = allCandidates.slice(
      startIndex,
      startIndex + AUTO_LOOP_PAGE_SIZE
    );

    setAutoLoopCandidates(nextCandidates);
    setAutoLoopCandidateCursor(startIndex + nextCandidates.length);
    setIsAutoLoopPanelCollapsed(false);

    if (nextCandidates.length === 0) {
      setAutoLoopPreviewCandidateId(null);
      updateAutoLoopCandidateOverlay(null, "#3b82f6", mode);
      setStatus(`더 이상 표시할 ${getCandidateModeLabel(mode)} 후보가 없습니다.`);
      return;
    }

    previewAutoLoopCandidate(nextCandidates[0], 0, true, mode);
    computeElevationSummariesForCandidates(nextCandidates);

    setStatus(
      `${getCandidateModeLabel(mode)} 후보 ${startIndex + 1}~${
        startIndex + nextCandidates.length
      } / ${allCandidates.length} 표시 중`
    );
  }

  function resetMarkersToCourseStart(course: Course) {
    const hasCourse = isRunnableCourse(course);
    const start = course.polyline[0];
    const finish = course.polyline[course.polyline.length - 1];
    const finishSameAsStart =
      hasCourse && start && finish && haversineDistanceM(start, finish) < 10;

    startMarkerRef.current?.getElement().style.setProperty(
      "display",
      hasCourse ? "block" : "none"
    );

    finishMarkerRef.current?.getElement().style.setProperty(
      "display",
      hasCourse && !finishSameAsStart ? "block" : "none"
    );

    playerMarkerRef.current?.getElement().style.setProperty(
      "display",
      hasCourse ? "flex" : "none"
    );

    if (!hasCourse || !start || !finish) {
      Object.values(botMarkerRefs.current).forEach((marker) => {
        marker.getElement().style.display = "none";
      });

      return;
    }

    startMarkerRef.current?.setLngLat(start);
    finishMarkerRef.current?.setLngLat(finish);
    playerMarkerRef.current?.setLngLat(start);

    DEFAULT_BOTS.forEach((bot) => {
      const marker = botMarkerRefs.current[bot.id];

      if (marker) {
        marker.setLngLat(start);
        marker.getElement().style.display = selectedBotIds.includes(bot.id)
          ? "flex"
          : "none";
      }
    });
  }

  function clearCustomPointMarkers() {
    Object.values(customPointMarkerRefs.current).forEach((marker) => {
      marker?.remove();
    });

    customPointMarkerRefs.current = {};
  }

  function updateCustomPointState(type: CustomPointStep, point: LngLat) {
    setCustomPoints((current) => ({
      ...current,
      [type]: point,
    }));
  }

  function setCustomPointMarker(type: CustomPointStep, point: LngLat) {
    const map = mapRef.current;
    if (!map) return;

    const existing = customPointMarkerRefs.current[type];

    if (existing) {
      existing.setLngLat(point);
      return;
    }

    const marker = new mapboxgl.Marker({
      element: createCustomPointMarkerElement(type),
      draggable: true,
      anchor: "bottom",
    })
      .setLngLat(point)
      .setPopup(new mapboxgl.Popup().setText(getCustomPointLabel(type)))
      .addTo(map);

    marker.on("dragstart", () => {
      marker.getElement().style.cursor = "grabbing";
      setCustomCourseError(null);
      setStatus(`${getCustomPointLabel(type)} 지점을 이동하는 중...`);
    });

    marker.on("drag", () => {
      const lngLat = marker.getLngLat();
      updateCustomPointState(type, [lngLat.lng, lngLat.lat]);
    });

    marker.on("dragend", () => {
      const lngLat = marker.getLngLat();
      const nextPoint: LngLat = [lngLat.lng, lngLat.lat];

      updateCustomPointState(type, nextPoint);
      marker.getElement().style.cursor = "grab";
      setCustomCourseError(null);
      setStatus(`${getCustomPointLabel(type)} 지점 이동 완료`);
    });

    customPointMarkerRefs.current[type] = marker;
  }

  function selectCustomPoint(type: CustomPointStep, point: LngLat) {
    updateCustomPointState(type, point);
    setCustomPointMarker(type, point);
    setCustomCourseError(null);

    if (type === "start") {
      setCustomPointStep("finish");
      setCustomGuide("select-finish");
      setStatus("시작지점 선택 완료 · 목표지점을 선택하세요.");
      return;
    }

    if (type === "turnaround") {
      setCustomPointStep("finish");
      setCustomGuide("select-finish");
      setStatus("반환점 선택 완료");
      return;
    }

    setCustomGuide("build-course");
    setStatus("종료지점 선택 완료");
  }

  function removeCustomPoint(type: CustomPointStep) {
    const marker = customPointMarkerRefs.current[type];
    marker?.remove();
    delete customPointMarkerRefs.current[type];

    const next = {
      ...customPoints,
      [type]: null,
    };

    setCustomPoints(next);

    if (!next.start) {
      setCustomPointStep("start");
      setCustomGuide("select-start");
    } else if (!next.finish) {
      setCustomPointStep(getNextRequiredStep(next));
      setCustomGuide("select-finish");
    } else {
      setCustomPointStep("finish");
      setCustomGuide("build-course");
    }

    setCustomCourseError(null);
    setStatus(`${getCustomPointLabel(type)} 지점을 취소했습니다.`);
  }

  function resetCustomCourseDraft() {
    setCustomPointStep("start");
    setCustomGuide("select-start");
    setCustomPoints(INITIAL_CUSTOM_POINTS);
    setCustomCourseError(null);
    setCustomRouteMode("oneWay");
    clearCustomPointMarkers();
    setStatus("수동 코스 지점을 초기화했습니다.");
  }

  function makeStoredCourseRecord({
    course,
    name,
    turnaround,
    source = "custom",
    courseMode = "custom",
    createdAt = Date.now(),
    courseId,
    favorite = false,
  }: {
    course: Course;
    name: string;
    turnaround: LngLat | null;
    source?: CourseOrigin;
    courseMode?: CandidateMode | "custom" | "saved" | null;
    createdAt?: number;
    courseId?: string;
    favorite?: boolean;
  }): StoredCourseRecord {
    const id = courseId ?? `course-origin-${createdAt}`;

    return {
      ...course,
      id,
      courseId: id,
      name,
      favorite,
      source,
      createdAt,
      updatedAt: createdAt,
      courseMode,
      turnaround,
      completionCount: 0,
      lastCompletedAt: null,
      bestElapsedSec: null,
    };
  }

  function makeRunRecord({
    course,
    courseId,
    courseName,
    courseMode,
    turnaround,
    completedAt = Date.now(),
    elapsedSec = null,
  }: {
    course: Course;
    courseId: string;
    courseName: string;
    courseMode: CandidateMode | "custom" | "saved" | null;
    turnaround: LngLat | null;
    completedAt?: number;
    elapsedSec?: number | null;
  }): RunRecord {
    return {
      runId: `run-record-${completedAt}`,
      courseId,
      courseName,
      distanceM: course.distanceM,
      polyline: course.polyline,
      completedAt,
      elapsedSec,
      courseMode,
      turnaround,
      updatedAt: completedAt,
    };
  }

  function updateCourseStatsAfterRun(courseId: string, completedAt: number, elapsedSec: number | null) {
    setCourseLibrary((current) =>
      current.map((course) => {
        if (course.courseId !== courseId) return course;

        const nextBestElapsedSec =
          elapsedSec === null || !Number.isFinite(elapsedSec)
            ? course.bestElapsedSec
            : course.bestElapsedSec === null
              ? elapsedSec
              : Math.min(course.bestElapsedSec, elapsedSec);

        return {
          ...course,
          completionCount: course.completionCount + 1,
          lastCompletedAt: Math.max(course.lastCompletedAt ?? 0, completedAt),
          bestElapsedSec: nextBestElapsedSec,
          updatedAt: Date.now(),
        };
      })
    );
  }

  function ensureStoredCourseForActiveRun({
    completedAt,
    fallbackName,
  }: {
    completedAt: number;
    fallbackName: string;
  }): StoredCourseRecord {
    if (activeCourseOriginId) {
      const existing = courseLibrary.find(
        (course) => course.courseId === activeCourseOriginId
      );

      if (existing) return existing;
    }

    const source: CourseOrigin = activeCourseMode === "custom" ? "custom" : "generated";
    const course = makeStoredCourseRecord({
      course: activeCourse,
      name: fallbackName,
      turnaround: activeCourseTurnaround,
      source,
      courseMode: activeCourseMode ?? "saved",
      createdAt: completedAt,
      courseId: `course-origin-${completedAt}`,
    });

    setCourseLibrary((current) => [course, ...current]);
    setActiveCourseOriginId(course.courseId);

    return course;
  }

  function saveRunRecord(record: RunRecord) {
    setRunRecords((current) => [record, ...current]);
  }

  function recordCompletedActiveCourse(finalElapsedSec: number) {
    if (!hasActiveCourse) return;

    const defaultName =
      activeCourse.name && activeCourse.name !== DEFAULT_COURSE.name
        ? activeCourse.name
        : `${getCandidateModeLabel(
            activeCourseMode === "oneWay" || activeCourseMode === "outAndBack"
              ? activeCourseMode
              : "outAndBack"
          )} 코스 ${(courseLengthM / 1000).toFixed(2)}km`;

    const completedAt = Date.now();
    const storedCourse = ensureStoredCourseForActiveRun({
      completedAt,
      fallbackName: defaultName,
    });

    const record = makeRunRecord({
      course: activeCourse,
      courseId: storedCourse.courseId,
      courseName: storedCourse.name,
      courseMode: activeCourseMode ?? storedCourse.courseMode ?? "saved",
      turnaround: activeCourseTurnaround,
      completedAt,
      elapsedSec: finalElapsedSec,
    });

    saveRunRecord(record);
    updateCourseStatsAfterRun(storedCourse.courseId, completedAt, finalElapsedSec);
  }

  function updateStoredCourseName(courseId: string, name: string) {
    setCourseLibrary((current) =>
      current.map((course) =>
        course.courseId === courseId
          ? {
              ...course,
              name,
              updatedAt: Date.now(),
            }
          : course
      )
    );
  }

  function toggleStoredCourseFavorite(courseId: string) {
    setCourseLibrary((current) =>
      current.map((course) =>
        course.courseId === courseId
          ? {
              ...course,
              favorite: !course.favorite,
              updatedAt: Date.now(),
            }
          : course
      )
    );
  }

  function applyStoredCourse(course: StoredCourseRecord) {
    const nextCourse: Course = {
      id: course.id,
      name: course.name,
      distanceM: course.distanceM,
      polyline: course.polyline,
    };

    gpsTracker.stop();
    latestGpsProjectionRef.current = null;
    clearCustomPointMarkers();
    clearAutoLoopCandidates();

    setIsCustomCourseMode(false);
    setCustomGuide(null);
    setCustomPoints(INITIAL_CUSTOM_POINTS);
    setActiveCourseTurnaround(course.turnaround);
    setActiveCourseMode(course.courseMode ?? "saved");
    setActiveCourseOriginId(course.courseId);
    setActiveCourse(nextCourse);
    setActivePanel("map");
    setSetupView("main");
    setStatus(`${course.name} 코스를 지도에 표시했습니다.`);
  }

  function handleRunStoredCourse(course: StoredCourseRecord) {
    applyStoredCourse(course);
    setIsRunSettingsOpen(true);
    setStatus(`${course.name} 코스로 러닝 설정을 확인하세요.`);
  }

  function deleteStoredCourse(courseId: string) {
    const target = courseLibrary.find((course) => course.courseId === courseId);

    if (target && !window.confirm(`"${target.name}" 저장 코스를 삭제할까요? 완주 기록은 유지됩니다.`)) {
      return;
    }

    setCourseLibrary((current) =>
      current.filter((course) => course.courseId !== courseId)
    );

    if (activeCourseOriginId === courseId) {
      setActiveCourseOriginId(null);
    }
  }

  function applyRunRecord(record: RunRecord) {
    const nextCourse: Course = {
      id: `run-snapshot-${record.runId}`,
      name: record.courseName,
      distanceM: record.distanceM,
      polyline: record.polyline,
    };

    gpsTracker.stop();
    latestGpsProjectionRef.current = null;
    clearCustomPointMarkers();
    clearAutoLoopCandidates();

    setIsCustomCourseMode(false);
    setCustomGuide(null);
    setActiveCourseTurnaround(record.turnaround);
    setActiveCourseMode(record.courseMode ?? "saved");
    setActiveCourseOriginId(record.courseId);
    setActiveCourse(nextCourse);
    setActivePanel("map");
    setSetupView("main");
    setStatus(`${record.courseName} 완주 기록 코스를 지도에 표시했습니다.`);
  }

  function updateRunRecordName(runId: string, name: string) {
    setRunRecords((current) =>
      current.map((record) =>
        record.runId === runId
          ? {
              ...record,
              courseName: name,
              updatedAt: Date.now(),
            }
          : record
      )
    );
  }

  function deleteRunRecord(runId: string) {
    const target = runRecords.find((record) => record.runId === runId);

    if (target && !window.confirm(`"${target.courseName}" 완주 기록을 삭제할까요?`)) {
      return;
    }

    setRunRecords((current) =>
      current.filter((record) => record.runId !== runId)
    );
  }

  function closeCustomGuide() {
    if (customGuide === "add-turnaround") {
      setCustomGuide("select-finish");
      setCustomPointStep("finish");
      setStatus("지도에서 종료지점을 선택하세요.");
      return;
    }

    setCustomGuide(null);
  }

  function parseAutoLoopTargetDistanceM(): number {
    const parsed = Number(autoLoopTargetKm.replace(",", "."));

    if (!Number.isFinite(parsed)) {
      return NaN;
    }

    return parsed * 1000;
  }

  function showTargetDistanceHint() {
    setIsTargetDistanceHintVisible(true);
    setAutoLoopError(null);
    setStatus("목표 거리를 입력해 주세요.");
    setActivePanel("setup");
    setSetupView("main");
  }

  function hideTargetDistanceHint() {
    setIsTargetDistanceHintVisible(false);
  }

  function handleShowMoreAutoLoopCandidates() {
    if (autoLoopAllCandidates.length === 0) return;

    if (autoLoopCandidateCursor >= autoLoopAllCandidates.length) {
      setStatus(`더 이상 표시할 ${getCandidateModeLabel(candidateMode)} 후보가 없습니다.`);
      return;
    }

    showAutoLoopCandidatePage(
      autoLoopAllCandidates,
      autoLoopCandidateCursor,
      candidateMode
    );
  }

  function handlePreviewAutoLoopCandidate(
    candidate: AutoLoopCourseCandidate,
    index: number
  ) {
    previewAutoLoopCandidate(candidate, index, true, candidateMode);

    if (!autoLoopElevationSummaries[candidate.candidateId]) {
      computeElevationSummariesForCandidates([candidate]);
    }

    setStatus(`${candidate.name} 미리보기 중`);
  }

  function handleApplyAutoLoopCandidate(candidate: AutoLoopCourseCandidate) {
    const mode = candidateMode;
    const label = getCandidateModeLabel(mode);

    const nextCourse: Course = {
      id: candidate.id,
      name: `${candidate.name} · ${(candidate.distanceM / 1000).toFixed(2)}km`,
      distanceM: candidate.distanceM,
      polyline: candidate.polyline,
    };

    gpsTracker.stop();
    latestGpsProjectionRef.current = null;
    clearCustomPointMarkers();
    clearAutoLoopCandidates();

    setIsCustomCourseMode(false);
    setCustomGuide(null);
    setCustomPoints(INITIAL_CUSTOM_POINTS);
    setPlayerMode("gps");
    setActiveCourseMode(mode);
    setActiveCourseOriginId(null);
    setActiveCourseTurnaround(mode === "outAndBack" ? candidate.endpoint : null);
    setActiveCourse(nextCourse);
    setActivePanel("map");
    setSetupView("main");
    setStatus(
      `${label} 코스 적용 완료 · ${(candidate.distanceM / 1000).toFixed(
        2
      )}km`
    );
  }

  function handleCloseAutoLoopPanel() {
    if (isGeneratingAutoLoop || isGeneratingOneWay || isGeneratingDrawRouteCandidates) {
      handleStopCourseSearch();
    }

    clearAutoLoopCandidates();
    setStatus(`${getCandidateModeLabel(candidateMode)} 후보 보기를 닫았습니다.`);
  }

  useEffect(() => {
    const isSecure =
      typeof window !== "undefined" ? window.isSecureContext : null;

    setIsSecureContextState(isSecure);

    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      setIsTestPanelEnabled(
        process.env.NODE_ENV === "development" ||
          params.get(TEST_PANEL_QUERY_PARAM) === "1"
      );
    }
  }, []);

  useEffect(() => {
    if (activePanel !== "map") {
      stopMapLocationWatch();
      return;
    }

    if (isSecureContextState === false) {
      setMapLocationError("현재 위치 기능은 HTTPS 환경 또는 localhost에서 사용해야 합니다.");
      return;
    }

    startMapLocationWatch();

    return () => {
      stopMapLocationWatch();
    };
    // 지도 탭 위치 표시용 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanel, isSecureContextState]);

  useEffect(() => {
    try {
      const rawCourseLibrary = window.localStorage.getItem(COURSE_LIBRARY_STORAGE_KEY);
      const rawRunRecords = window.localStorage.getItem(RUN_RECORDS_STORAGE_KEY);

      let nextCourseLibrary: StoredCourseRecord[] = [];
      let nextRunRecords: RunRecord[] = [];

      if (rawCourseLibrary) {
        const parsed = JSON.parse(rawCourseLibrary);

        if (Array.isArray(parsed)) {
          nextCourseLibrary = parsed
            .map(validateStoredCourseRecord)
            .filter((course): course is StoredCourseRecord => Boolean(course));
        }
      }

      if (rawRunRecords) {
        const parsed = JSON.parse(rawRunRecords);

        if (Array.isArray(parsed)) {
          nextRunRecords = parsed
            .map(validateRunRecord)
            .filter((record): record is RunRecord => Boolean(record));
        }
      }

      if (!rawCourseLibrary && !rawRunRecords) {
        const rawLegacyCustomCourses = window.localStorage.getItem(
          LEGACY_CUSTOM_COURSES_STORAGE_KEY
        );
        const rawLegacySavedCourses = window.localStorage.getItem(
          LEGACY_SAVED_COURSES_STORAGE_KEY
        );

        const migratedCustomCourses = rawLegacyCustomCourses
          ? JSON.parse(rawLegacyCustomCourses)
          : [];
        const migratedRunSource = rawLegacySavedCourses
          ? JSON.parse(rawLegacySavedCourses)
          : [];

        const legacyCustomCourses = Array.isArray(migratedCustomCourses)
          ? migratedCustomCourses
              .map(makeStoredCourseFromLegacyCustom)
              .filter((course): course is StoredCourseRecord => Boolean(course))
          : [];
        const { migratedCourses, migratedRuns } = makeLegacyRunMigration(migratedRunSource);
        const byCourseId = new Map<string, StoredCourseRecord>();

        [...legacyCustomCourses, ...migratedCourses].forEach((course) => {
          byCourseId.set(course.courseId, course);
        });

        nextCourseLibrary = Array.from(byCourseId.values());
        nextRunRecords = migratedRuns;
      }

      setCourseLibrary(nextCourseLibrary);
      setRunRecords(nextRunRecords);
    } catch (loadError) {
      console.warn("Failed to load course library/run records:", loadError);
      setCourseLibrary([]);
      setRunRecords([]);
    } finally {
      setHasLoadedCourseLibrary(true);
      setHasLoadedRunRecords(true);
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedRunRecords) return;

    window.localStorage.setItem(
      RUN_RECORDS_STORAGE_KEY,
      JSON.stringify(runRecords)
    );
  }, [runRecords, hasLoadedRunRecords]);

  useEffect(() => {
    if (!hasLoadedCourseLibrary) return;

    window.localStorage.setItem(
      COURSE_LIBRARY_STORAGE_KEY,
      JSON.stringify(courseLibrary)
    );
  }, [courseLibrary, hasLoadedCourseLibrary]);

  useEffect(() => {
    latestGpsProjectionRef.current = gpsTracker.latestProjection;
  }, [gpsTracker.latestProjection]);

  useEffect(() => {
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

    if (!token) {
      setError("NEXT_PUBLIC_MAPBOX_TOKEN이 .env.local에 없습니다.");
      return;
    }

    if (!token.startsWith("pk.")) {
      setError(
        `Mapbox public token 형식이 아닙니다. 현재 시작값: ${token.slice(
          0,
          10
        )}`
      );
      return;
    }

    if (!mapContainerRef.current) return;
    if (mapRef.current) return;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: DEFAULT_CENTER,
      zoom: 13.5,
      pitch: 0,
      bearing: 0,
    });

    mapRef.current = map;

    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    map.on("load", () => {
      setStatus("코스를 선택해 주세요.");
      setIsMapLoaded(true);

      enableTerrainElevationSource(map);

      startMarkerRef.current = new mapboxgl.Marker({ color: "#16a34a" })
        .setLngLat(DEFAULT_CENTER)
        .setPopup(new mapboxgl.Popup().setText("Start"))
        .addTo(map);

      startMarkerRef.current.getElement().style.display = "none";

      finishMarkerRef.current = new mapboxgl.Marker({ color: "#dc2626" })
        .setLngLat(DEFAULT_CENTER)
        .setPopup(new mapboxgl.Popup().setText("Finish"))
        .addTo(map);

      finishMarkerRef.current.getElement().style.display = "none";

      playerMarkerRef.current = new mapboxgl.Marker({
        element: createRunnerMarkerElement("You", "🏃", "#16a34a"),
        anchor: "bottom",
      })
        .setLngLat(DEFAULT_CENTER)
        .setPopup(new mapboxgl.Popup().setText("You"))
        .addTo(map);

      playerMarkerRef.current.getElement().style.display = "none";

      currentLocationMarkerRef.current = new mapboxgl.Marker({
        element: createCurrentLocationMarkerElement(),
        anchor: "center",
      })
        .setLngLat(DEFAULT_CENTER)
        .setPopup(new mapboxgl.Popup().setText("현재 위치"))
        .addTo(map);

      currentLocationMarkerRef.current.getElement().style.display = "none";

      DEFAULT_BOTS.forEach((bot) => {
        const marker = new mapboxgl.Marker({
          element: createRunnerMarkerElement(bot.name, "🤖", "#2563eb"),
          anchor: "bottom",
        })
          .setLngLat(DEFAULT_CENTER)
          .setPopup(
            new mapboxgl.Popup().setText(
              `${bot.name} · ${formatPace(bot.paceSecPerKm)}`
            )
          )
          .addTo(map);

        marker.getElement().style.display = "none";

        botMarkerRefs.current[bot.id] = marker;
      });

      setRunnerHud(createInitialHud());
    });

    map.on("error", (event) => {
      console.error("Mapbox error:", event);
      setError(
        "Mapbox 로딩 에러가 발생했습니다. 개발자도구 Console/Network를 확인하세요."
      );
    });

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      courseSearchAbortControllerRef.current?.abort();
      courseSearchAbortControllerRef.current = null;
      stopMapLocationWatch();
      gpsTracker.stop();
      clearCustomPointMarkers();

      startMarkerRef.current?.remove();
      startMarkerRef.current = null;

      finishMarkerRef.current?.remove();
      finishMarkerRef.current = null;

      playerMarkerRef.current?.remove();
      playerMarkerRef.current = null;

      currentLocationMarkerRef.current?.remove();
      currentLocationMarkerRef.current = null;

      activeTurnaroundMarkerRef.current?.remove();
      activeTurnaroundMarkerRef.current = null;

      previewTurnaroundMarkerRef.current?.remove();
      previewTurnaroundMarkerRef.current = null;

      Object.values(botMarkerRefs.current).forEach((marker) => marker.remove());
      botMarkerRefs.current = {};

      map.remove();
      mapRef.current = null;
    };
    // 최초 지도 생성용 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isMapLoaded) return;

    if (isRunnableCourse(activeCourse)) {
      updateCourseSource(activeCourse);
      fitMapToCourse(activeCourse);
    }

    resetMarkersToCourseStart(activeCourse);
    updateActiveTurnaroundMarker(activeCourseTurnaround);

    setRunnerHud(createInitialHud());
    setElapsedSec(0);
    setStartTimeMs(null);
    latestGpsProjectionRef.current = null;
    completionRecordedForRunRef.current = false;

    // activeCourse 변경 시 지도와 HUD를 확정 동기화
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCourse, activeCourseTurnaround, activeCourseMode, isMapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleMapClick = (event: mapboxgl.MapMouseEvent) => {
      if (!isCustomCourseMode || activePanel !== "map" || isRunning) return;

      const target = event.originalEvent.target;

      if (
        target instanceof HTMLElement &&
        target.closest(".mapboxgl-marker")
      ) {
        return;
      }

      const point: LngLat = [event.lngLat.lng, event.lngLat.lat];

      selectCustomPoint(customPointStep, point);
    };

    map.on("click", handleMapClick);

    return () => {
      map.off("click", handleMapClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustomCourseMode, activePanel, isRunning, customPointStep]);

  useEffect(() => {
    function handleResize() {
      window.setTimeout(() => {
        mapRef.current?.resize();
      }, 120);
    }

    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, []);

  useEffect(() => {
    window.setTimeout(() => {
      mapRef.current?.resize();
    }, 120);
  }, [
    activePanel,
    isLeaderboardOpen,
    isAutoLoopPanelVisible,
    isAutoLoopPanelCollapsed,
  ]);

  useEffect(() => {
    if (!isMapLoaded || !currentMapLocation) return;

    const marker = currentLocationMarkerRef.current;
    if (!marker) return;

    marker.setLngLat(currentMapLocation);
    marker.getElement().style.setProperty("display", "flex");

    marker.setPopup(
      new mapboxgl.Popup().setText(
        currentMapLocationAccuracyM !== null
          ? `현재 위치 · 정확도 ${currentMapLocationAccuracyM.toFixed(1)}m`
          : "현재 위치"
      )
    );
  }, [isMapLoaded, currentMapLocation, currentMapLocationAccuracyM]);

  useEffect(() => {
    Object.entries(botMarkerRefs.current).forEach(([botId, marker]) => {
      marker.getElement().style.display =
        selectedBotIds.includes(botId) && hasActiveCourse ? "flex" : "none";
    });

    if (!isRunning) {
      setRunnerHud(createInitialHud());
    }

    // 봇 선택 변경 시 HUD와 marker 표시만 동기화
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBotIds, isRunning, hasActiveCourse]);

  useEffect(() => {
    if (!isRunning || startTimeMs === null || !hasActiveCourse) return;

    const tick = () => {
      const now = Date.now();
      const nextElapsedSec = (now - startTimeMs) / 1000;

      let playerDistanceM = 0;
      let playerLngLat = getLngLatAtDistance(activeCourse.polyline, 0);
      let playerHudPaceSecPerKm = playerPaceSecPerKm;

      if (playerMode === "pace") {
        const playerSpeedMps = paceToSpeedMps(playerPaceSecPerKm);
        playerDistanceM = Math.min(
          playerSpeedMps * nextElapsedSec,
          courseLengthM
        );
        playerLngLat = getLngLatAtDistance(
          activeCourse.polyline,
          playerDistanceM
        );
      } else {
        const projection = latestGpsProjectionRef.current;

        if (projection) {
          playerDistanceM = Math.min(projection.raceDistanceM, courseLengthM);
          playerLngLat = projection.snappedLngLat;

          if (projection.currentPaceSecPerKm !== null) {
            playerHudPaceSecPerKm = clampPaceSecPerKm(
              projection.currentPaceSecPerKm
            );
          }
        }
      }

      playerMarkerRef.current?.setLngLat(playerLngLat);

      const playerHud: RunnerHudState = {
        id: "player",
        name: playerName || "Me",
        type: "player",
        paceSecPerKm: playerHudPaceSecPerKm,
        distanceM: playerDistanceM,
        progressPercent: (playerDistanceM / courseLengthM) * 100,
        finished: playerDistanceM >= courseLengthM,
      };

      const botHud: RunnerHudState[] = selectedBots.map((bot) => {
        const speedMps = paceToSpeedMps(bot.paceSecPerKm);
        const rawDistanceM = speedMps * nextElapsedSec;
        const distanceM = Math.min(rawDistanceM, courseLengthM);
        const currentLngLat = getLngLatAtDistance(
          activeCourse.polyline,
          distanceM
        );

        const marker = botMarkerRefs.current[bot.id];
        if (marker) {
          marker.setLngLat(currentLngLat);
        }

        return {
          id: bot.id,
          name: bot.name,
          type: "bot",
          paceSecPerKm: bot.paceSecPerKm,
          distanceM,
          progressPercent: (distanceM / courseLengthM) * 100,
          finished: distanceM >= courseLengthM,
        };
      });

      const nextHud = [playerHud, ...botHud];

      if (playerHud.finished && !completionRecordedForRunRef.current) {
        completionRecordedForRunRef.current = true;
        recordCompletedActiveCourse(nextElapsedSec);
        setStatus("완주 완료 · 나의 코스에 기록되었습니다.");
      }

      if (now - lastHudUpdateRef.current > 250) {
        setElapsedSec(nextElapsedSec);
        setRunnerHud(nextHud);
        lastHudUpdateRef.current = now;
      }

      const allFinished = nextHud.every((runner) => runner.finished);

      if (!allFinished) {
        animationFrameRef.current = requestAnimationFrame(tick);
      } else {
        setIsRunning(false);
        gpsTracker.stop();
        setStatus("레이스 종료 · 완주 기록 저장 완료");
      }
    };

    animationFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [
    isRunning,
    startTimeMs,
    courseLengthM,
    playerName,
    playerPaceSecPerKm,
    playerMode,
    selectedBots,
    gpsTracker.stop,
    activeCourse,
    hasActiveCourse,
  ]);

  function handleToggleBot(botId: string) {
    if (isRunning) return;

    setSelectedBotIds((current) => {
      if (current.includes(botId)) {
        return current.filter((id) => id !== botId);
      }

      return [...current, botId];
    });
  }

  function handleStartCustomCourseMode() {
    if (isCustomCourseStartDisabled) return;

    clearAutoLoopCandidates();
    setIsDrawRouteMode(false);
    setDrawnRoutePoints([]);
    drawnRoutePointsRef.current = [];
    setDrawRouteError(null);
    clearDrawRouteOverlay();
    setIsCustomCourseMode(true);
    setCustomPointStep("start");
    setCustomGuide("select-start");
    setCustomPoints(INITIAL_CUSTOM_POINTS);
    setCustomCourseError(null);
    setShouldSaveCustomCourse(true);
    setCustomCourseName("");
    setCustomRouteMode("oneWay");
    setIsCustomPanelCollapsed(false);
    clearCustomPointMarkers();
    setIsLeaderboardOpen(false);
    setActivePanel("map");
    setSetupView("main");
    setStatus("수동 코스 생성: 시작지점을 선택하세요.");
  }

  function handleCancelCustomCourseMode() {
    setIsCustomCourseMode(false);
    setCustomPointStep("start");
    setCustomGuide(null);
    setCustomPoints(INITIAL_CUSTOM_POINTS);
    setCustomCourseError(null);
    setCustomRouteMode("oneWay");
    clearCustomPointMarkers();
    setStatus("수동 코스 생성을 취소했습니다.");
  }

  function clearDrawRouteOverlay() {
    const map = mapRef.current;
    if (!map) return;

    const source = map.getSource("draw-route-draft") as
      | mapboxgl.GeoJSONSource
      | undefined;

    if (source) {
      source.setData({
        type: "FeatureCollection",
        features: [],
      } as GeoJSON.FeatureCollection<GeoJSON.LineString>);
    }
  }

  function updateDrawRouteOverlay(points: LngLat[]) {
    const map = mapRef.current;
    if (!map) return;

    const data = {
      type: "FeatureCollection",
      features:
        points.length >= 2
          ? [
              {
                type: "Feature",
                properties: {},
                geometry: {
                  type: "LineString",
                  coordinates: points,
                },
              },
            ]
          : [],
    } as GeoJSON.FeatureCollection<GeoJSON.LineString>;

    const source = map.getSource("draw-route-draft") as
      | mapboxgl.GeoJSONSource
      | undefined;

    if (source) {
      source.setData(data);
      return;
    }

    map.addSource("draw-route-draft", {
      type: "geojson",
      data,
    });

    map.addLayer({
      id: "draw-route-draft-line",
      type: "line",
      source: "draw-route-draft",
      layout: {
        "line-join": "round",
        "line-cap": "round",
      },
      paint: {
        "line-width": 6,
        "line-color": "#0f172a",
        "line-opacity": 0.82,
        "line-blur": 0.5,
      },
    });
  }

  function getLngLatFromPointerEvent(event: PointerEvent<HTMLElement>): LngLat | null {
    return getLngLatFromClientPoint(event.clientX, event.clientY);
  }

  function getLngLatFromClientPoint(clientX: number, clientY: number): LngLat | null {
    const map = mapRef.current;
    const container = mapContainerRef.current;

    if (!map || !container) return null;

    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      return null;
    }

    const point = map.unproject([x, y]);
    return [point.lng, point.lat];
  }

  function getPointerDistancePx(
    a: { clientX: number; clientY: number },
    b: { clientX: number; clientY: number }
  ): number {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function getFirstTwoDrawPointers(): Array<{ clientX: number; clientY: number }> {
    return Array.from(drawRouteActivePointersRef.current.values()).slice(0, 2);
  }

  function clearDrawRoutePointerSession() {
    drawRoutePointerRef.current = null;
    drawRouteActivePointersRef.current.clear();
    drawRoutePinchRef.current = null;
    setIsDrawingRoute(false);
  }

  function handleSetDrawRouteInteractionMode(mode: DrawRouteInteractionMode) {
    clearDrawRoutePointerSession();
    setDrawRouteInteractionMode(mode);
    setDrawRouteError(null);
    setStatus(
      mode === "draw"
        ? "그리기 모드: 한 손가락으로 코스를 그리고, 두 손가락으로 확대/축소할 수 있습니다."
        : "지도 이동 모드: 지도를 자유롭게 움직인 뒤 그리기 모드로 돌아오세요."
    );
  }

  function appendDrawnRoutePoint(point: LngLat) {
    setDrawnRoutePoints((current) => {
      const last = current[current.length - 1];

      if (last && haversineDistanceM(last, point) < 6) {
        return current;
      }

      const next = [...current, point];
      drawnRoutePointsRef.current = next;
      updateDrawRouteOverlay(next);
      return next;
    });
  }

  function handleStartDrawRouteMode() {
    if (isDrawRouteStartDisabled) return;

    clearAutoLoopCandidates();
    clearCustomPointMarkers();
    setIsCustomCourseMode(false);
    setCustomGuide(null);
    setCustomPoints(INITIAL_CUSTOM_POINTS);
    setCustomCourseError(null);
    setIsDrawRouteMode(true);
    setIsDrawPanelCollapsed(false);
    setDrawRouteInteractionMode("draw");
    setDrawnRoutePoints([]);
    drawnRoutePointsRef.current = [];
    setDrawRouteError(null);
    clearDrawRoutePointerSession();
    clearDrawRouteOverlay();
    setIsLeaderboardOpen(false);
    setActivePanel("map");
    setSetupView("main");
    setStatus("코스 그리기 모드: 한 손가락으로 그리고, 두 손가락으로 확대/축소할 수 있습니다.");
  }

  function handleCancelDrawRouteMode() {
    setIsDrawRouteMode(false);
    setIsDrawPanelCollapsed(false);
    setDrawRouteInteractionMode("draw");
    setDrawnRoutePoints([]);
    drawnRoutePointsRef.current = [];
    setDrawRouteError(null);
    clearDrawRoutePointerSession();
    clearDrawRouteOverlay();
    setStatus("코스 그리기 모드를 종료했습니다.");
  }

  function handleResetDrawRoute() {
    if (isGeneratingDrawRouteCandidates) {
      courseSearchAbortControllerRef.current?.abort();
      courseSearchAbortControllerRef.current = null;
      courseSearchRunIdRef.current += 1;
      setIsGeneratingDrawRouteCandidates(false);
    }

    setDrawnRoutePoints([]);
    drawnRoutePointsRef.current = [];
    setDrawRouteError(null);
    clearDrawRoutePointerSession();
    clearDrawRouteOverlay();
    setIsDrawPanelCollapsed(false);
    setStatus("그린 선을 초기화했습니다. 다시 지도 위에 그려주세요.");
  }

  function handleRestartDrawRouteAfterSearch() {
    if (isGeneratingAnyCourse) {
      handleStopCourseSearch();
    }

    clearAutoLoopCandidates();
    clearDrawRoutePointerSession();
    clearDrawRouteOverlay();
    setIsDrawRouteMode(true);
    setIsDrawPanelCollapsed(false);
    setDrawRouteInteractionMode("draw");
    setDrawnRoutePoints([]);
    drawnRoutePointsRef.current = [];
    setDrawRouteError(null);
    setActivePanel("map");
    setStatus("다시 그리기: 한 손가락으로 새 코스를 그려주세요.");
  }

  function beginDrawRoutePinchZoom() {
    const map = mapRef.current;
    const [first, second] = getFirstTwoDrawPointers();

    if (!map || !first || !second) return;

    const startDistancePx = getPointerDistancePx(first, second);

    if (startDistancePx <= 0) return;

    drawRoutePinchRef.current = {
      startDistancePx,
      startZoom: map.getZoom(),
    };

    drawRoutePointerRef.current = null;
    setIsDrawingRoute(false);
    setIsDrawPanelCollapsed(true);
  }

  function updateDrawRoutePinchZoom() {
    const map = mapRef.current;
    const [first, second] = getFirstTwoDrawPointers();

    if (!map || !first || !second) return;

    if (!drawRoutePinchRef.current) {
      beginDrawRoutePinchZoom();
    }

    const pinch = drawRoutePinchRef.current;
    if (!pinch) return;

    const nextDistancePx = getPointerDistancePx(first, second);
    if (nextDistancePx <= 0) return;

    const scale = Math.max(0.35, Math.min(3.5, nextDistancePx / pinch.startDistancePx));
    const nextZoom = Math.max(
      map.getMinZoom(),
      Math.min(map.getMaxZoom(), pinch.startZoom + Math.log2(scale))
    );
    const midpointClientX = (first.clientX + second.clientX) / 2;
    const midpointClientY = (first.clientY + second.clientY) / 2;
    const around = getLngLatFromClientPoint(midpointClientX, midpointClientY);

    if (around) {
      const zoomOptions: mapboxgl.AnimationOptions & {
        around: mapboxgl.LngLatLike;
      } = {
        around,
        duration: 0,
      };

      map.zoomTo(nextZoom, zoomOptions);
    } else {
      map.zoomTo(nextZoom, { duration: 0 });
    }
  }

  function handleDrawRoutePointerDown(event: PointerEvent<HTMLElement>) {
    if (!isDrawRouteMode || isGeneratingDrawRouteCandidates) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drawRouteActivePointersRef.current.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
    });

    if (drawRouteActivePointersRef.current.size >= 2) {
      beginDrawRoutePinchZoom();
      setStatus("두 손가락으로 지도를 확대/축소하는 중입니다.");
      return;
    }

    if (drawRouteInteractionMode !== "draw") return;

    if (!isDrawingRoute && drawnRoutePointsRef.current.length >= 2) {
      setStatus("이미 그린 선이 인식되었습니다. 다시 그리기를 눌러 새 코스를 그려주세요.");
      return;
    }

    const point = getLngLatFromPointerEvent(event);
    if (!point) return;

    drawRoutePointerRef.current = {
      pointerId: event.pointerId,
      hasMoved: false,
    };

    setDrawRouteError(null);
    drawnRoutePointsRef.current = [point];
    setDrawnRoutePoints([point]);
    updateDrawRouteOverlay([point]);
    setIsDrawingRoute(true);
    setIsDrawPanelCollapsed(true);
    setStatus("손가락을 떼면 자동으로 코스 후보를 찾습니다.");
  }

  function handleDrawRoutePointerMove(event: PointerEvent<HTMLElement>) {
    if (!drawRouteActivePointersRef.current.has(event.pointerId)) return;

    event.preventDefault();
    drawRouteActivePointersRef.current.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
    });

    if (drawRouteActivePointersRef.current.size >= 2) {
      updateDrawRoutePinchZoom();
      return;
    }

    const draw = drawRoutePointerRef.current;
    if (!draw || draw.pointerId !== event.pointerId) return;

    const point = getLngLatFromPointerEvent(event);
    if (!point) return;

    draw.hasMoved = true;
    appendDrawnRoutePoint(point);
  }

  function handleDrawRoutePointerEnd(event: PointerEvent<HTMLElement>) {
    const draw = drawRoutePointerRef.current;
    const wasDrawingPointer = Boolean(draw && draw.pointerId === event.pointerId);
    const wasPinching = Boolean(drawRoutePinchRef.current);

    if (drawRouteActivePointersRef.current.has(event.pointerId)) {
      event.preventDefault();
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      drawRouteActivePointersRef.current.delete(event.pointerId);
    }

    if (wasPinching) {
      if (drawRouteActivePointersRef.current.size < 2) {
        drawRoutePinchRef.current = null;
        setIsDrawPanelCollapsed(false);
        setStatus("지도 확대/축소 완료 · 그리기 모드에서 계속 그릴 수 있습니다.");
      }
      return;
    }

    if (!wasDrawingPointer || !draw) return;

    drawRoutePointerRef.current = null;
    setIsDrawingRoute(false);
    setIsDrawPanelCollapsed(false);

    if (!draw.hasMoved || drawnRoutePointsRef.current.length < 2) {
      setDrawRouteError("너무 짧게 그렸습니다. 시작점에서 목표 방향까지 조금 더 길게 그려주세요.");
      setStatus("코스 그리기 실패: 선이 너무 짧습니다.");
      return;
    }

    setStatus("그린 선을 확인했습니다. 가능한 코스 후보를 자동으로 찾는 중...");
    void handleGenerateDrawnRouteCandidates();
  }

  function handleDrawRoutePointerCancel(event: PointerEvent<HTMLElement>) {
    if (drawRouteActivePointersRef.current.has(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      drawRouteActivePointersRef.current.delete(event.pointerId);
    }

    if (drawRoutePointerRef.current?.pointerId === event.pointerId) {
      drawRoutePointerRef.current = null;
    }

    if (drawRouteActivePointersRef.current.size < 2) {
      drawRoutePinchRef.current = null;
    }

    setIsDrawingRoute(false);
    setIsDrawPanelCollapsed(false);
  }

  async function handleGenerateDrawnRouteCandidates() {
    if (isRunning || isGeneratingAnyCourse) return;

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

    if (!token) {
      setDrawRouteError("Mapbox token이 없습니다.");
      return;
    }

    const routeDrawnPoints =
      drawnRoutePointsRef.current.length >= 2
        ? drawnRoutePointsRef.current
        : drawnRoutePoints;

    if (routeDrawnPoints.length < 2) {
      setDrawRouteError("지도 위에 코스 방향을 먼저 그려주세요.");
      return;
    }

    const isCircularSketch = isLikelyCircularDrawnRoute(routeDrawnPoints);
    const drawCandidateLabel = isCircularSketch ? "원형" : "그리기";

    const { runId, signal } = beginCourseSearch();

    try {
      setIsGeneratingDrawRouteCandidates(true);
      setDrawRouteError(null);
      setCandidateMode("oneWay");
      clearAutoLoopCandidates();
      setStatus(
        isCircularSketch
          ? "원형으로 그린 선을 둘러가는 보행 코스 후보를 찾는 중..."
          : "그린 선을 따라갈 수 있는 보행 코스 후보를 찾는 중..."
      );

      const candidates = await generateDrawnRouteCandidates({
        drawnPoints: routeDrawnPoints,
        token,
        signal,
      });

      if (!isCurrentCourseSearch(runId, signal)) {
        return;
      }

      if (candidates.length === 0) {
        setDrawRouteError(
          isCircularSketch
            ? "원형으로 둘러가는 보행 코스 후보를 찾지 못했습니다."
            : "그린 방향을 따라갈 수 있는 보행 코스 후보를 찾지 못했습니다."
        );
        setStatus(`${drawCandidateLabel} 후보 없음`);
        return;
      }

      setIsDrawRouteMode(false);
      setIsDrawPanelCollapsed(false);
      setDrawRouteInteractionMode("move");
      setDrawRouteError(null);
      clearDrawRouteOverlay();
      setAutoLoopAllCandidates(candidates);
      showAutoLoopCandidatePage(candidates, 0, "oneWay");
      setStatus(`${drawCandidateLabel} 후보 ${Math.min(candidates.length, AUTO_LOOP_PAGE_SIZE)}개 표시 중`);
    } catch (rawError) {
      if (isCourseSearchAbortError(rawError)) {
        if (isCurrentCourseSearch(runId, signal)) {
          setStatus("코스 탐색을 중지했습니다.");
        }
        return;
      }

      if (!isCurrentCourseSearch(runId, signal)) {
        return;
      }

      const message =
        rawError instanceof Error
          ? rawError.message
          : "그린 코스 후보를 생성하지 못했습니다.";

      setDrawRouteError(message);
      setStatus("그리기 후보 생성 실패");
    } finally {
      if (isCurrentCourseSearch(runId, signal)) {
        setIsGeneratingDrawRouteCandidates(false);
        finishCourseSearch(runId);
      }
    }
  }

  function handleAddTurnaroundPoint() {
    if (!customPoints.start) {
      setCustomCourseError("먼저 시작지점을 선택해야 합니다.");
      return;
    }

    if (customPoints.finish) {
      setCustomCourseError("이미 종료지점을 선택했습니다. 다시 만들려면 취소 후 시작하세요.");
      return;
    }

    setCustomPointStep("turnaround");
    setCustomGuide("select-turnaround");
    setCustomCourseError(null);
    setStatus("지도에서 반환점을 선택하세요.");
  }

  function handleUseStartAsFinish() {
    if (!customPoints.start) {
      setCustomCourseError("먼저 시작지점을 선택해야 합니다.");
      return;
    }

    if (!customPoints.turnaround) {
      setCustomCourseError("시작과 종료가 같으려면 반환점이 필요합니다.");
      return;
    }

    selectCustomPoint("finish", customPoints.start);
  }

  async function handleBuildCustomCourse() {
    if (isRunning) return;

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

    if (!token) {
      setCustomCourseError("Mapbox token이 없습니다.");
      return;
    }

    if (!customPoints.start) {
      setCustomCourseError("시작지점은 필수입니다.");
      return;
    }

    if (!customPoints.finish) {
      setCustomCourseError("종료지점은 필수입니다.");
      return;
    }

    const trimmedName = customCourseName.trim();
    const routeModeLabel = customRouteMode === "outAndBack" ? "왕복" : "편도";
    const finalName =
      trimmedName || `커스텀 코스 ${sortedCourseLibrary.length + 1} · ${routeModeLabel}`;

    const routeTurnaround =
      customRouteMode === "outAndBack" ? customPoints.finish : null;
    const routeFinish =
      customRouteMode === "outAndBack" ? customPoints.start : customPoints.finish;

    try {
      setIsGeneratingCustomCourse(true);
      setCustomCourseError(null);
      setStatus("선택한 지점 기준으로 커스텀 코스를 생성하는 중...");

      const nextCourse = await generateCustomWalkingCourse({
        start: customPoints.start,
        turnaround: routeTurnaround,
        finish: routeFinish,
        token,
        name: finalName,
      });

      let storedCustomCourse: StoredCourseRecord | null = null;

      if (shouldSaveCustomCourse) {
        storedCustomCourse = makeStoredCourseRecord({
          course: nextCourse,
          name: finalName,
          turnaround: routeTurnaround,
          source: "custom",
          courseMode: "custom",
        });

        setCourseLibrary((current) => [storedCustomCourse!, ...current]);
      }

      gpsTracker.stop();
      latestGpsProjectionRef.current = null;
      clearCustomPointMarkers();
      clearAutoLoopCandidates();

      setIsCustomCourseMode(false);
      setCustomGuide(null);
      setCustomPointStep("start");
      setCustomPoints(INITIAL_CUSTOM_POINTS);
      setCustomCourseName("");
      setActiveCourseMode("custom");
      setActiveCourseOriginId(storedCustomCourse?.courseId ?? null);
      setActiveCourseTurnaround(routeTurnaround);
      setActiveCourse(nextCourse);
      setActivePanel("map");
      setSetupView("main");
      setStatus(
        shouldSaveCustomCourse
          ? `커스텀 코스 생성 및 저장 완료 · ${(nextCourse.distanceM / 1000).toFixed(
              2
            )}km`
          : `저장 없이 커스텀 코스 생성 완료 · ${(nextCourse.distanceM / 1000).toFixed(
              2
            )}km`
      );
    } catch (rawError) {
      const message =
        rawError instanceof Error
          ? rawError.message
          : "커스텀 코스를 생성하지 못했습니다.";

      setCustomCourseError(message);
      setStatus("커스텀 코스 생성 실패");
    } finally {
      setIsGeneratingCustomCourse(false);
    }
  }

  async function handleGenerateOutAndBackCandidates() {
    if (isGeneratedCourseControlsDisabled) return;

    const targetDistanceM = parseAutoLoopTargetDistanceM();

    if (!Number.isFinite(targetDistanceM) || targetDistanceM <= 0) {
      showTargetDistanceHint();
      return;
    }

    hideTargetDistanceHint();
    setCandidateMode("outAndBack");
    setAutoLoopError(null);
    setGpsActionError(null);
    setCustomCourseError(null);
    setAutoLoopAllCandidates([]);
    setAutoLoopCandidates([]);
    setAutoLoopCandidateCursor(0);
    setAutoLoopPreviewCandidateId(null);
    setAutoLoopElevationSummaries({});
    clearAutoLoopCandidateOverlay();

    setIsAutoLoopPanelCollapsed(false);
    setActivePanel("map");
    setSetupView("main");

    if (isSecureContextState === false) {
      setAutoLoopError("왕복 코스 생성은 HTTPS 환경에서 테스트해야 합니다.");
      return;
    }

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

    if (!token) {
      setAutoLoopError("Mapbox token이 없습니다.");
      return;
    }

    const { runId, signal } = beginCourseSearch();

    try {
      setIsGeneratingAutoLoop(true);
      setStatus("현재 위치를 가져오는 중...");

      const position = await getCurrentPosition();

      if (!isCurrentCourseSearch(runId, signal)) {
        return;
      }

      const accuracy = position.coords.accuracy;

      if (accuracy > 120) {
        setAutoLoopError(
          `현재 위치 정확도가 낮습니다. accuracy=${accuracy.toFixed(
            1
          )}m. 야외에서 다시 시도하세요.`
        );
        setStatus("현재 위치 정확도 부족");
        return;
      }

      const origin: LngLat = [
        position.coords.longitude,
        position.coords.latitude,
      ];

      setCurrentMapLocation(origin);
      setCurrentMapLocationAccuracyM(accuracy);
      setMapLocationError(null);

      currentLocationMarkerRef.current?.setLngLat(origin);
      currentLocationMarkerRef.current?.getElement().style.setProperty(
        "display",
        "flex"
      );

      playerMarkerRef.current?.setLngLat(origin);

      mapRef.current?.flyTo({
        center: origin,
        zoom: 15.5,
        duration: 600,
      });

      setStatus(
        `현재 위치 기준 ${(targetDistanceM / 1000).toFixed(
          1
        )}km 왕복 후보를 찾는 중...`
      );

      const candidates = await generateAutoLoopCourseCandidates({
        origin,
        token,
        targetDistanceM,
        toleranceM: DEFAULT_DISTANCE_TOLERANCE_M,
      });

      if (!isCurrentCourseSearch(runId, signal)) {
        return;
      }

      if (candidates.length === 0) {
        setAutoLoopError("생성 가능한 왕복 후보를 찾지 못했습니다.");
        setStatus("왕복 후보 없음");
        return;
      }

      setAutoLoopAllCandidates(candidates);
      showAutoLoopCandidatePage(candidates, 0, "outAndBack");
    } catch (rawError) {
      if (isCourseSearchAbortError(rawError)) {
        if (isCurrentCourseSearch(runId, signal)) {
          setStatus("코스 탐색을 중지했습니다.");
        }
        return;
      }

      if (!isCurrentCourseSearch(runId, signal)) {
        return;
      }

      const message = getPositionErrorMessage(rawError);

      setAutoLoopError(message);
      setStatus("왕복 후보 생성 실패");
    } finally {
      if (isCurrentCourseSearch(runId, signal)) {
        setIsGeneratingAutoLoop(false);
        finishCourseSearch(runId);
      }
    }
  }

  async function handleGenerateOneWayCandidates() {
    if (isGeneratedCourseControlsDisabled) return;

    const targetDistanceM = parseAutoLoopTargetDistanceM();

    if (!Number.isFinite(targetDistanceM) || targetDistanceM <= 0) {
      showTargetDistanceHint();
      return;
    }

    hideTargetDistanceHint();
    setCandidateMode("oneWay");
    setAutoLoopError(null);
    setGpsActionError(null);
    setCustomCourseError(null);
    setAutoLoopAllCandidates([]);
    setAutoLoopCandidates([]);
    setAutoLoopCandidateCursor(0);
    setAutoLoopPreviewCandidateId(null);
    setAutoLoopElevationSummaries({});
    clearAutoLoopCandidateOverlay();

    setIsAutoLoopPanelCollapsed(false);
    setActivePanel("map");
    setSetupView("main");

    if (isSecureContextState === false) {
      setAutoLoopError("편도 코스 생성은 HTTPS 환경에서 테스트해야 합니다.");
      return;
    }

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

    if (!token) {
      setAutoLoopError("Mapbox token이 없습니다.");
      return;
    }

    const { runId, signal } = beginCourseSearch();

    try {
      setIsGeneratingOneWay(true);
      setStatus("현재 위치를 가져오는 중...");

      const position = await getCurrentPosition();

      if (!isCurrentCourseSearch(runId, signal)) {
        return;
      }

      const accuracy = position.coords.accuracy;

      if (accuracy > 120) {
        setAutoLoopError(
          `현재 위치 정확도가 낮습니다. accuracy=${accuracy.toFixed(
            1
          )}m. 야외에서 다시 시도하세요.`
        );
        setStatus("현재 위치 정확도 부족");
        return;
      }

      const origin: LngLat = [
        position.coords.longitude,
        position.coords.latitude,
      ];

      setCurrentMapLocation(origin);
      setCurrentMapLocationAccuracyM(accuracy);
      setMapLocationError(null);

      currentLocationMarkerRef.current?.setLngLat(origin);
      currentLocationMarkerRef.current?.getElement().style.setProperty(
        "display",
        "flex"
      );

      playerMarkerRef.current?.setLngLat(origin);

      mapRef.current?.flyTo({
        center: origin,
        zoom: 15.5,
        duration: 600,
      });

      setStatus(
        `현재 위치 기준 ${(targetDistanceM / 1000).toFixed(
          1
        )}km 편도 후보를 찾는 중...`
      );

      const candidates = await generateOneWayCourseCandidates({
        origin,
        token,
        targetDistanceM,
        toleranceM: DEFAULT_DISTANCE_TOLERANCE_M,
        signal,
      });

      if (!isCurrentCourseSearch(runId, signal)) {
        return;
      }

      if (candidates.length === 0) {
        setAutoLoopError("생성 가능한 편도 후보를 찾지 못했습니다.");
        setStatus("편도 후보 없음");
        return;
      }

      setAutoLoopAllCandidates(candidates);
      showAutoLoopCandidatePage(candidates, 0, "oneWay");
    } catch (rawError) {
      if (isCourseSearchAbortError(rawError)) {
        if (isCurrentCourseSearch(runId, signal)) {
          setStatus("코스 탐색을 중지했습니다.");
        }
        return;
      }

      if (!isCurrentCourseSearch(runId, signal)) {
        return;
      }

      const message = getPositionErrorMessage(rawError);

      setAutoLoopError(message);
      setStatus("편도 후보 생성 실패");
    } finally {
      if (isCurrentCourseSearch(runId, signal)) {
        setIsGeneratingOneWay(false);
        finishCourseSearch(runId);
      }
    }
  }

  function handleOpenRunSettings() {
    if (isRunning) return;

    if (!hasActiveCourse) {
      setStatus("먼저 코스를 생성하거나 선택해야 합니다.");
      setActivePanel("setup");
      setSetupView("main");
      return;
    }

    setIsRunSettingsOpen(true);
  }

  function handleConfirmStartRace() {
    setIsRunSettingsOpen(false);
    handleStartRace();
  }

  function handleStartRace() {
    setIsRunSettingsOpen(false);
    if (!isMapLoaded) return;

    if (!hasActiveCourse) {
      setStatus("먼저 코스를 생성하거나 선택해야 합니다.");
      setActivePanel("setup");
      setSetupView("main");
      return;
    }

    if (playerMode === "gps" && isSecureContextState === false) {
      setStatus("GPS Beta는 HTTPS 환경에서 테스트해야 합니다.");
      setActivePanel("setup");
      return;
    }

    clearAutoLoopCandidates();
    resetMarkersToCourseStart(activeCourse);
    updateActiveTurnaroundMarker(activeCourseTurnaround);
    completionRecordedForRunRef.current = false;

    if (playerMode === "gps") {
      gpsTracker.reset();
      latestGpsProjectionRef.current = null;
      gpsTracker.start();
      setStatus("GPS Beta 레이스 진행 중");
    } else {
      gpsTracker.stop();
      setStatus("페이스 입력 레이스 진행 중");
    }

    setRunnerHud(createInitialHud());
    setElapsedSec(0);
    setStartTimeMs(Date.now());
    setIsRunning(true);
    setIsLeaderboardOpen(true);
    setActivePanel("map");
    setSetupView("main");
  }

  function handleResetRace() {
    setIsRunSettingsOpen(false);

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    gpsTracker.stop();
    latestGpsProjectionRef.current = null;

    resetMarkersToCourseStart(activeCourse);
    updateActiveTurnaroundMarker(activeCourseTurnaround);

    setIsRunning(false);
    setStartTimeMs(null);
    setElapsedSec(0);
    setStatus("레이스 초기화 완료");
    setRunnerHud(createInitialHud());
  }

  const sortedHud = [...runnerHud].sort((a, b) => b.distanceM - a.distanceM);

  const playerRank =
    sortedHud.findIndex((runner) => runner.id === "player") + 1 || 0;

  const playerHud = sortedHud.find((runner) => runner.id === "player");

  const runnerAhead = playerRank > 1 ? sortedHud[playerRank - 2] : undefined;

  const gapToAhead =
    runnerAhead && playerHud
      ? Math.max(runnerAhead.distanceM - playerHud.distanceM, 0)
      : 0;

  const gpsDistanceText = gpsTracker.latestProjection
    ? `${gpsTracker.latestProjection.raceDistanceM.toFixed(1)}m`
    : "-";

  const gpsAccuracyText = gpsTracker.latestSample
    ? `${gpsTracker.latestSample.accuracy.toFixed(1)}m`
    : "-";

  const gpsOffCourseText = gpsTracker.latestProjection
    ? `${gpsTracker.latestProjection.offCourseDistanceM.toFixed(1)}m`
    : "-";

  const isGpsBlockedBySecurity =
    playerMode === "gps" && isSecureContextState === false;

  const isDrawnCandidatePanel =
    autoLoopAllCandidates.some((candidate) =>
      candidate.candidateId.startsWith("draw-route-candidate")
    ) ||
    autoLoopCandidates.some((candidate) =>
      candidate.candidateId.startsWith("draw-route-candidate")
    );
  const candidateModeLabel = isDrawnCandidatePanel
    ? "그리기"
    : getCandidateModeLabel(candidateMode);

  const currentMapLocationText = currentMapLocation
    ? `${currentMapLocation[1].toFixed(5)}, ${currentMapLocation[0].toFixed(5)}`
    : "현재 위치 미확인";

  const currentMapLocationAccuracyText =
    currentMapLocationAccuracyM !== null
      ? `정확도 ${currentMapLocationAccuracyM.toFixed(1)}m`
      : "정확도 -";

  function getBottomSheetCollapsedState(sheet: BottomSheetKind): boolean {
    if (sheet === "candidate") return isAutoLoopPanelCollapsed;
    if (sheet === "mapHud") return !isLeaderboardOpen;
    if (sheet === "custom") return isCustomPanelCollapsed;
    return isDrawPanelCollapsed;
  }

  function setBottomSheetCollapsedState(
    sheet: BottomSheetKind,
    shouldCollapse: boolean
  ) {
    if (sheet === "candidate") {
      setIsAutoLoopPanelCollapsed(shouldCollapse);
      return;
    }

    if (sheet === "mapHud") {
      setIsLeaderboardOpen(!shouldCollapse);
      return;
    }

    if (sheet === "custom") {
      setIsCustomPanelCollapsed(shouldCollapse);
      return;
    }

    setIsDrawPanelCollapsed(shouldCollapse);
  }

  function resetBottomSheetDragOffset(sheet: BottomSheetKind) {
    setBottomSheetDragOffsetY((current) => ({
      ...current,
      [sheet]: 0,
    }));
  }

  function getBottomSheetDragStyle(sheet: BottomSheetKind): CSSProperties {
    return {
      "--sheet-drag-y": `${bottomSheetDragOffsetY[sheet]}px`,
      transition: draggingSheet === sheet ? "none" : undefined,
    } as CSSProperties;
  }

  function handleBottomSheetHandleClick(sheet: BottomSheetKind) {
    if (bottomSheetSuppressTapRef.current) {
      bottomSheetSuppressTapRef.current = false;
      return;
    }

    setBottomSheetCollapsedState(sheet, !getBottomSheetCollapsedState(sheet));
  }

  function handleBottomSheetDragStart(
    sheet: BottomSheetKind,
    event: PointerEvent<HTMLElement>
  ) {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const startCollapsed = getBottomSheetCollapsedState(sheet);

    bottomSheetDragRef.current = {
      sheet,
      startY: event.clientY,
      lastY: event.clientY,
      startCollapsed,
    };

    bottomSheetSuppressTapRef.current = false;
    resetBottomSheetDragOffset(sheet);
    setDraggingSheet(sheet);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleBottomSheetDragMove(
    sheet: BottomSheetKind,
    event: PointerEvent<HTMLElement>
  ) {
    const drag = bottomSheetDragRef.current;

    if (!drag || drag.sheet !== sheet) return;

    drag.lastY = event.clientY;

    const rawDeltaY = event.clientY - drag.startY;
    if (Math.abs(rawDeltaY) > 8) {
      bottomSheetSuppressTapRef.current = true;
    }

    const minDeltaY = drag.startCollapsed ? -260 : -42;
    const maxDeltaY = drag.startCollapsed ? 70 : 300;
    const nextOffsetY = Math.max(minDeltaY, Math.min(maxDeltaY, rawDeltaY));

    setBottomSheetDragOffsetY((current) => ({
      ...current,
      [sheet]: nextOffsetY,
    }));
  }

  function handleBottomSheetDragEnd(
    sheet: BottomSheetKind,
    event: PointerEvent<HTMLElement>
  ) {
    const drag = bottomSheetDragRef.current;

    if (!drag || drag.sheet !== sheet) return;

    const deltaY = drag.lastY - drag.startY;
    bottomSheetDragRef.current = null;

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDraggingSheet(null);
    resetBottomSheetDragOffset(sheet);

    if (bottomSheetSuppressTapRef.current) {
      window.setTimeout(() => {
        bottomSheetSuppressTapRef.current = false;
      }, 220);
    }

    if (deltaY <= -54) {
      setBottomSheetCollapsedState(sheet, false);
      return;
    }

    if (deltaY >= 54) {
      setBottomSheetCollapsedState(sheet, true);
    }
  }

  function handleBottomSheetDragCancel() {
    const drag = bottomSheetDragRef.current;
    bottomSheetDragRef.current = null;
    setDraggingSheet(null);

    if (drag) {
      resetBottomSheetDragOffset(drag.sheet);
    }
  }

  function handleOpenFeedback() {
    if (FEEDBACK_FORM_URL) {
      window.open(FEEDBACK_FORM_URL, "_blank", "noopener,noreferrer");
      return;
    }

    window.alert(
      "피드백 링크를 곧 연결할 예정입니다. 지금은 테스트 후 느낀 점을 직접 알려주세요."
    );
  }


  function makeDevTestCourse({
    id,
    name,
    distanceM,
    offset,
  }: {
    id: string;
    name: string;
    distanceM: number;
    offset: number;
  }): Course {
    const start: LngLat = [DEFAULT_CENTER[0] + offset, DEFAULT_CENTER[1] + offset];
    const turnaround: LngLat = [
      DEFAULT_CENTER[0] + offset + 0.006,
      DEFAULT_CENTER[1] + offset + 0.003,
    ];

    return {
      id,
      name,
      distanceM,
      polyline: [start, turnaround, start],
    };
  }

  function handleDevCompleteCurrentCourse() {
    if (!hasActiveCourse) {
      setStatus("테스트 완주 처리할 코스를 먼저 선택하세요.");
      return;
    }

    const estimatedElapsedSec = Math.max(
      30,
      Math.round(courseLengthM / paceToSpeedMps(playerPaceSecPerKm))
    );

    recordCompletedActiveCourse(estimatedElapsedSec);
    setStatus("테스트 완주 기록을 나의 코스에 추가했습니다.");
    setActivePanel("setup");
    setSetupView("myCourses");
  }

  function handleDevSeedCompletedCourses() {
    const now = Date.now();
    const favoriteCourse = makeDevTestCourse({
      id: `dev-favorite-course-${now}`,
      name: "테스트 자주 뛰는 3K 왕복",
      distanceM: 3020,
      offset: 0,
    });
    const historyCourse = makeDevTestCourse({
      id: `dev-history-course-${now}`,
      name: "테스트 완주 기록 5K",
      distanceM: 5080,
      offset: 0.01,
    });
    const customCourse = makeDevTestCourse({
      id: `dev-custom-course-${now}`,
      name: "테스트 저장 커스텀 3K",
      distanceM: 2880,
      offset: -0.01,
    });

    const favoriteStoredCourse = makeStoredCourseRecord({
      course: favoriteCourse,
      name: favoriteCourse.name,
      turnaround: favoriteCourse.polyline[1],
      source: "completed-import",
      courseMode: "outAndBack",
      createdAt: now - 60_000,
      courseId: `dev-favorite-course-origin-${now}`,
      favorite: true,
    });
    const historyStoredCourse = makeStoredCourseRecord({
      course: historyCourse,
      name: historyCourse.name,
      turnaround: historyCourse.polyline[1],
      source: "completed-import",
      courseMode: "outAndBack",
      createdAt: now - 3_600_000,
      courseId: `dev-history-course-origin-${now}`,
    });
    const customStoredCourse = makeStoredCourseRecord({
      course: customCourse,
      name: customCourse.name,
      turnaround: [DEFAULT_CENTER[0] - 0.004, DEFAULT_CENTER[1] - 0.002],
      source: "custom",
      courseMode: "custom",
      createdAt: now - 120_000,
      courseId: `dev-custom-course-origin-${now}`,
      favorite: true,
    });

    const favoriteRecord = makeRunRecord({
      course: favoriteCourse,
      courseId: favoriteStoredCourse.courseId,
      courseName: favoriteStoredCourse.name,
      courseMode: "outAndBack",
      turnaround: favoriteCourse.polyline[1],
      completedAt: now - 60_000,
      elapsedSec: 18 * 60 + 25,
    });
    const historyRecord = makeRunRecord({
      course: historyCourse,
      courseId: historyStoredCourse.courseId,
      courseName: historyStoredCourse.name,
      courseMode: "outAndBack",
      turnaround: historyCourse.polyline[1],
      completedAt: now - 3_600_000,
      elapsedSec: 31 * 60 + 10,
    });

    const favoriteCourseWithStats: StoredCourseRecord = {
      ...favoriteStoredCourse,
      completionCount: 1,
      lastCompletedAt: favoriteRecord.completedAt,
      bestElapsedSec: favoriteRecord.elapsedSec,
    };
    const historyCourseWithStats: StoredCourseRecord = {
      ...historyStoredCourse,
      completionCount: 1,
      lastCompletedAt: historyRecord.completedAt,
      bestElapsedSec: historyRecord.elapsedSec,
    };

    setRunRecords((current) => [favoriteRecord, historyRecord, ...current]);
    setCourseLibrary((current) => [
      customStoredCourse,
      favoriteCourseWithStats,
      historyCourseWithStats,
      ...current,
    ]);
    setStatus("테스트 저장 코스 3개와 완주 기록 2개를 추가했습니다.");
    setActivePanel("setup");
    setSetupView("myCourses");
  }

  function handleDevApplyShortCourse() {
    const now = Date.now();
    const shortCourse: Course = {
      id: `dev-short-course-${now}`,
      name: "개발 테스트 120m 코스",
      distanceM: 120,
      polyline: [
        DEFAULT_CENTER,
        [DEFAULT_CENTER[0] + 0.001, DEFAULT_CENTER[1] + 0.0004],
      ],
    };

    gpsTracker.stop();
    latestGpsProjectionRef.current = null;
    clearCustomPointMarkers();
    clearAutoLoopCandidates();
    setIsCustomCourseMode(false);
    setCustomGuide(null);
    setActiveCourseTurnaround(null);
    setActiveCourseMode("custom");
    setActiveCourseOriginId(null);
    setActiveCourse(shortCourse);
    setPlayerMode("pace");
    setPaceInput("3:00");
    setActivePanel("map");
    setSetupView("main");
    setStatus("짧은 테스트 코스를 적용했습니다. 페이스 입력 테스트로 빠르게 완주할 수 있습니다.");
  }

  function handleDevClearLocalRecords() {
    if (!window.confirm("완주 기록과 저장 코스 데이터를 모두 삭제할까요?")) {
      return;
    }

    setRunRecords([]);
    setCourseLibrary([]);
    setStatus("테스트 저장 데이터를 초기화했습니다.");
  }

  function renderRunRecordCard(record: RunRecord) {
    return (
      <div
        key={`history-${record.runId}`}
        role="button"
        tabIndex={0}
        onClick={() => applyRunRecord(record)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            applyRunRecord(record);
          }
        }}
        className="cursor-pointer rounded-2xl border border-slate-200 bg-white p-3 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:bg-blue-50 hover:shadow-md"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                완주 기록
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                {getRunRecordModeLabel(record.courseMode)}
              </span>
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                {(record.distanceM / 1000).toFixed(2)}km
              </span>
            </div>

            <label
              className="mt-1 block space-y-1"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <div className="text-[10px] font-semibold text-slate-400">
                기록 이름
              </div>

              <input
                value={record.courseName}
                onChange={(event) =>
                  updateRunRecordName(record.runId, event.target.value)
                }
                onBlur={(event) => {
                  const trimmedName = event.target.value.trim();

                  if (!trimmedName) {
                    updateRunRecordName(record.runId, "완주 기록");
                    return;
                  }

                  if (trimmedName !== event.target.value) {
                    updateRunRecordName(record.runId, trimmedName);
                  }
                }}
                className="w-full rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm font-black text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </label>

            <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600">
              <div className="rounded-xl bg-slate-50 px-2 py-1.5">
                <div className="text-[10px] font-semibold text-slate-400">
                  완료 시간
                </div>
                <div className="font-bold text-slate-800">
                  {formatCompletedTime(record.completedAt)}
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 px-2 py-1.5">
                <div className="text-[10px] font-semibold text-slate-400">
                  기록
                </div>
                <div className="font-bold text-slate-800">
                  {formatDuration(record.elapsedSec)}
                </div>
              </div>
            </div>

            {record.turnaround && (
              <div className="mt-2 rounded-xl bg-orange-50 px-2 py-1.5 text-[11px] font-semibold text-orange-700">
                반환점: {formatPoint(record.turnaround)}
              </div>
            )}

            <div className="mt-2 text-[11px] font-bold text-blue-700">
              기록을 누르면 당시 완주한 코스를 지도에서 볼 수 있습니다.
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-1.5">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                deleteRunRecord(record.runId);
              }}
              className="rounded-xl bg-red-50 px-2 py-2 text-xs font-bold text-red-700 hover:bg-red-100"
            >
              삭제
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderStoredCourseCard(
    course: StoredCourseRecord,
    variant: "favorite" | "library" = "library"
  ) {
    const isFavoriteCard = variant === "favorite";

    return (
      <div
        key={`${variant}-${course.courseId}`}
        className={`rounded-2xl border p-3 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${
          isFavoriteCard
            ? "border-yellow-200 bg-gradient-to-br from-yellow-50 via-white to-orange-50 hover:border-yellow-300"
            : "border-slate-200 bg-white hover:border-blue-300 hover:bg-blue-50"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {isFavoriteCard && (
                <span className="rounded-full bg-yellow-400 px-2 py-0.5 text-[10px] font-black text-yellow-950">
                  자주 뛸 코스
                </span>
              )}
              <span className="rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-bold text-purple-700">
                {getCourseSourceLabel(course.source)}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                {getStoredCourseModeLabel(course.courseMode)}
              </span>
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-700">
                {(course.distanceM / 1000).toFixed(2)}km
              </span>
            </div>

            <label
              className="block space-y-1"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <div className="text-[11px] font-semibold text-slate-500">
                코스 이름
              </div>
              <input
                value={course.name}
                onChange={(event) =>
                  updateStoredCourseName(course.courseId, event.target.value)
                }
                className="w-full rounded-xl border border-slate-200 bg-white/90 px-3 py-2 text-sm font-bold text-slate-900 outline-none transition focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100"
              />
            </label>

            <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-slate-600">
              <div className="rounded-xl bg-slate-50 px-2 py-1.5">
                <div className="text-[10px] font-semibold text-slate-400">
                  완주 횟수
                </div>
                <div className="font-bold text-slate-800">
                  {course.completionCount}회
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 px-2 py-1.5">
                <div className="text-[10px] font-semibold text-slate-400">
                  최근 완주
                </div>
                <div className="font-bold text-slate-800">
                  {course.lastCompletedAt
                    ? formatCompletedDate(course.lastCompletedAt)
                    : "없음"}
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 px-2 py-1.5">
                <div className="text-[10px] font-semibold text-slate-400">
                  최고 기록
                </div>
                <div className="font-bold text-slate-800">
                  {formatDuration(course.bestElapsedSec)}
                </div>
              </div>
            </div>

            {course.turnaround && (
              <div className="mt-2 rounded-xl bg-orange-50 px-2 py-1.5 text-[11px] font-semibold text-orange-700">
                반환점: {formatPoint(course.turnaround)}
              </div>
            )}

            <div className="mt-2 text-[11px] font-bold text-blue-700">
              지도에서 먼저 확인하거나, 바로 러닝 설정으로 이동할 수 있습니다.
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => applyStoredCourse(course)}
                className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-700 transition hover:bg-slate-200"
              >
                지도에서 보기
              </button>

              <button
                type="button"
                onClick={() => handleRunStoredCourse(course)}
                className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white shadow-sm transition hover:bg-blue-700"
              >
                이 코스로 달리기
              </button>
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-1.5">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                toggleStoredCourseFavorite(course.courseId);
              }}
              className={`rounded-xl px-2 py-2 text-xs font-black transition ${
                course.favorite
                  ? "bg-yellow-400 text-yellow-950 hover:bg-yellow-300"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {course.favorite ? "★" : "☆"}
            </button>

            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                deleteStoredCourse(course.courseId);
              }}
              className="rounded-xl bg-red-50 px-2 py-2 text-xs font-bold text-red-700 hover:bg-red-100"
            >
              삭제
            </button>
          </div>
        </div>
      </div>
    );
  }


  return (
    <div
      className={[
        "race-root",
        activePanel === "setup" ? "race-root-setup" : "race-root-map",
        activePanel === "map" && isAutoLoopPanelVisible
          ? "race-root-auto-loop-open"
          : "",
        activePanel === "map" && isAutoLoopPanelCollapsed
          ? "race-root-auto-loop-collapsed"
          : "",
        activePanel === "map" && isCustomCourseMode
          ? "race-root-custom-course-open"
          : "",
        activePanel === "map" && isCustomCourseMode && isCustomPanelCollapsed
          ? "race-root-custom-course-collapsed"
          : "",
        activePanel === "map" && isDrawRouteMode
          ? "race-root-draw-open"
          : "",
        activePanel === "map" && isDrawRouteMode && isDrawPanelCollapsed
          ? "race-root-draw-collapsed"
          : "",
        activePanel === "map" &&
        !isAutoLoopPanelVisible &&
        !isCustomCourseMode &&
        !isDrawRouteMode
          ? "race-root-map-hud-open"
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <svg
        className="liquid-filter-svg"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <filter
            id="liquid-glass-soft"
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.018 0.026"
              numOctaves="2"
              seed="11"
              result="liquidNoise"
            />
            <feGaussianBlur
              in="liquidNoise"
              stdDeviation="0.6"
              result="softNoise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="softNoise"
              scale="2.2"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>

          <filter
            id="liquid-background-warp"
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.010 0.014"
              numOctaves="3"
              seed="23"
              result="backgroundNoise"
            />
            <feGaussianBlur
              in="backgroundNoise"
              stdDeviation="1.1"
              result="backgroundSoftNoise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="backgroundSoftNoise"
              scale="8"
              xChannelSelector="R"
              yChannelSelector="B"
            />
          </filter>
        </defs>
      </svg>

      <div ref={mapContainerRef} className="race-map" />

      {activePanel === "setup" && <div className="setup-background" />}
      <SetupLiquidShaderCanvas isActive={activePanel === "setup"} />

      {activePanel === "map" && isDrawRouteMode && drawRouteInteractionMode === "draw" && (
        <div
          className="draw-route-gesture-layer"
          aria-label="지도 위에 코스 방향 그리기"
          role="presentation"
          onPointerDown={handleDrawRoutePointerDown}
          onPointerMove={handleDrawRoutePointerMove}
          onPointerUp={handleDrawRoutePointerEnd}
          onPointerCancel={handleDrawRoutePointerCancel}
        />
      )}

      {activePanel === "map" && isDrawRouteMode && drawnRouteDistanceM !== null && (
        <div
          className={`draw-route-live-distance-badge ${
            isDrawingRoute ? "draw-route-live-distance-badge-active" : ""
          }`}
          aria-live="polite"
        >
          <span>그린 길이</span>
          <strong>{formatDraftDistance(drawnRouteDistanceM)}</strong>
        </div>
      )}

      <div className="race-top-tabs">
        <button
          type="button"
          onClick={() => {
            setActivePanel("setup");
            setSetupView("main");
          }}
          className={`race-tab-button ${
            activePanel === "setup" ? "race-tab-active" : ""
          }`}
        >
          설정
        </button>

        <button
          type="button"
          onClick={() => setActivePanel("map")}
          className={`race-tab-button ${
            activePanel === "map" ? "race-tab-active" : ""
          }`}
        >
          지도
        </button>
      </div>

      {activePanel === "map" && (
        <div className="map-location-control">
          <button
            type="button"
            onClick={handleCenterMapOnCurrentLocation}
            disabled={isCenteringOnCurrentLocation}
            className="map-location-button"
          >
            {isCenteringOnCurrentLocation ? "위치 확인 중..." : "내 위치로"}
          </button>

          <div
            className={`map-location-meta ${
              mapLocationError ? "map-location-meta-error" : ""
            }`}
          >
            {mapLocationError
              ? mapLocationError
              : `${currentMapLocationText} · ${currentMapLocationAccuracyText}`}
          </div>
        </div>
      )}

      {activePanel === "map" && isDrawRouteMode && (
        <div className="draw-route-floating-mode-controls" aria-label="지도 조작 모드">
          <button
            type="button"
            onClick={() => handleSetDrawRouteInteractionMode("draw")}
            aria-label="그리기 모드"
            title="그리기 모드"
            className={`draw-route-floating-mode-button ${
              drawRouteInteractionMode === "draw" ? "draw-route-floating-mode-active" : ""
            }`}
          >
            ✎
          </button>

          <button
            type="button"
            onClick={() => handleSetDrawRouteInteractionMode("move")}
            aria-label="지도 이동 모드"
            title="지도 이동 모드"
            className={`draw-route-floating-mode-button ${
              drawRouteInteractionMode === "move" ? "draw-route-floating-mode-active" : ""
            }`}
          >
            ✋
          </button>
        </div>
      )}

      {isRunSettingsOpen && (
        <div
          className="run-settings-backdrop"
          onClick={() => setIsRunSettingsOpen(false)}
        >
          <div
            className="run-settings-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-black text-slate-900">
                  러닝 설정
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  GPS로 실제 러닝을 기록하거나, 페이스 입력으로 테스트할 수 있습니다.
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsRunSettingsOpen(false)}
                className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
              >
                닫기
              </button>
            </div>

            <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-700">
              <div className="font-bold text-slate-900">{activeCourse.name}</div>
              <div className="mt-1">길이 {(courseLengthM / 1000).toFixed(2)} km</div>
              {activeCourseTurnaround && (
                <div className="mt-1 text-orange-700">
                  반환점: {formatPoint(activeCourseTurnaround)}
                </div>
              )}
            </div>

            <label className="mt-3 block space-y-1">
              <div className="text-xs font-semibold text-slate-600">닉네임</div>
              <input
                value={playerName}
                onChange={(event) => setPlayerName(event.target.value)}
                disabled={isRunning}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 disabled:bg-slate-100"
              />
            </label>

            <div className="mt-3">
              <div className="mb-2 text-xs font-semibold text-slate-600">
                기록 방식
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setPlayerMode("gps")}
                  disabled={isRunning}
                  className={`liquid-choice-button rounded-xl px-3 py-3 text-sm font-bold ${
                    playerMode === "gps"
                      ? "liquid-selected-control"
                      : "liquid-clear-control"
                  } disabled:cursor-not-allowed`}
                >
                  GPS로 실제 달리기
                </button>

                <button
                  type="button"
                  onClick={() => setPlayerMode("pace")}
                  disabled={isRunning}
                  className={`liquid-choice-button rounded-xl px-3 py-3 text-sm font-bold ${
                    playerMode === "pace"
                      ? "liquid-selected-control"
                      : "liquid-clear-control"
                  } disabled:cursor-not-allowed`}
                >
                  페이스 입력 테스트
                </button>
              </div>

              {playerMode === "gps" ? (
                <div className="mt-2 rounded-lg bg-orange-50 p-2 text-xs text-orange-900">
                  {isGpsBlockedBySecurity ? (
                    <div className="font-semibold text-red-700">
                      GPS는 HTTPS 배포 주소 또는 localhost에서만 사용할 수 있습니다.
                    </div>
                  ) : (
                    <div>
                      현재 위치 기반으로 실제 진행 거리와 페이스를 계산합니다.
                    </div>
                  )}
                  <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                    <div>GPS 상태: {getGpsStatusLabel(gpsTracker.status)}</div>
                    <div>정확도: {gpsAccuracyText}</div>
                    <div>GPS 거리: {gpsDistanceText}</div>
                    <div>코스 이탈: {gpsOffCourseText}</div>
                  </div>
                </div>
              ) : (
                <label className="mt-2 block space-y-1 rounded-lg bg-green-50 p-2">
                  <div className="text-xs font-semibold text-green-900">
                    테스트용 내 페이스
                  </div>
                  <input
                    value={paceInput}
                    onChange={(event) => setPaceInput(event.target.value)}
                    disabled={isRunning}
                    placeholder="5:30"
                    className="w-full rounded-lg border border-green-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-green-500 disabled:bg-slate-100"
                  />
                  <div className="text-[11px] text-green-800">
                    입력 페이스: {formatPace(playerPaceSecPerKm)}
                  </div>
                </label>
              )}
            </div>

            <div className="mt-3">
              <div className="mb-2 text-xs font-semibold text-slate-600">
                가상 페이스메이커
              </div>
              <div className="grid grid-cols-1 gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedBotIds([])}
                  disabled={isRunning}
                  className={`liquid-choice-button rounded-xl px-3 py-3 text-left text-sm font-semibold ${
                    selectedBotIds.length === 0
                      ? "liquid-selected-control"
                      : "liquid-clear-control"
                  } disabled:cursor-not-allowed`}
                >
                  없음 · 혼자 달리기
                </button>

                {DEFAULT_BOTS.map((bot) => {
                  const selected = selectedBotIds.includes(bot.id);

                  return (
                    <button
                      key={bot.id}
                      type="button"
                      onClick={() => setSelectedBotIds([bot.id])}
                      disabled={isRunning}
                      className={`liquid-choice-button rounded-xl px-3 py-3 text-left text-sm font-semibold ${
                        selected
                          ? "liquid-selected-control"
                          : "liquid-clear-control"
                      } disabled:cursor-not-allowed`}
                    >
                      <span className="block">{bot.name}</span>
                      <span
                        className={`block text-xs ${
                          selected ? "text-blue-100" : "text-slate-500"
                        }`}
                      >
                        {formatPace(bot.paceSecPerKm)} 페이스메이커
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setIsRunSettingsOpen(false)}
                className="rounded-xl bg-slate-100 px-3 py-3 text-sm font-bold text-slate-700"
              >
                취소
              </button>

              <button
                type="button"
                onClick={handleConfirmStartRace}
                disabled={
                  !isMapLoaded ||
                  isRunning ||
                  !hasActiveCourse ||
                  (playerMode === "gps" && isGpsBlockedBySecurity)
                }
                className="rounded-xl bg-blue-600 px-3 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                러닝 시작
              </button>
            </div>
          </div>
        </div>
      )}

      {activePanel === "setup" && setupView === "main" && (
        <div className="race-panel race-setup-panel">
          {error ? (
            <div className="rounded-xl bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          ) : (
            <div className="mx-auto max-w-[560px] space-y-3">
              <div className="hero-glass-card overflow-hidden rounded-[28px] border border-white/40 bg-slate-950/55 p-5 text-white shadow-2xl shadow-slate-900/20 backdrop-blur">
                <div className="text-xs font-semibold uppercase tracking-[0.26em] text-emerald-200">
                  PaceRace
                </div>
                <div className="mt-3 text-3xl font-black leading-tight tracking-[-0.04em]">
                  오늘 어디를 뛸까요?
                </div>
                <div className="mt-2 max-w-[420px] text-sm font-semibold leading-relaxed text-slate-100">
                  현재 위치에서 바로 뛸 수 있는 3K·5K·10K 러닝 코스를 찾아드립니다.
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-900">
                    코스
                  </div>

                  <button
                    type="button"
                    onClick={() => setSetupView("myCourses")}
                    className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
                  >
                    나의 코스
                  </button>
                </div>

                <div className="rounded-lg bg-slate-50 p-2 text-xs text-slate-700">
                  {hasActiveCourse ? (
                    <>
                      <div className="font-semibold text-slate-900">
                        {activeCourse.name}
                      </div>
                      <div>길이: {(courseLengthM / 1000).toFixed(2)} km</div>
                      {activeCourseTurnaround && (
                        <div className="mt-1 text-orange-700">
                          반환점: {formatPoint(activeCourseTurnaround)}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="font-semibold text-slate-900">
                        아직 선택된 코스가 없습니다.
                      </div>
                      <div>왕복 후보 또는 편도 후보를 먼저 선택하세요.</div>
                    </>
                  )}
                </div>

                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2">
                  <div className="mb-2 text-xs font-semibold text-slate-700">
                    현재 위치 기준 코스 생성
                  </div>

                  <div className="space-y-2">
                    <div className="text-[11px] font-medium text-slate-500">
                      목표 거리 km
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { label: "3K", value: "3.0" },
                        { label: "5K", value: "5.0" },
                        { label: "10K", value: "10.0" },
                      ].map((preset) => {
                        const isActive = autoLoopTargetKm === preset.value;

                        return (
                          <button
                            key={preset.value}
                            type="button"
                            onClick={() => {
                              setAutoLoopTargetKm(preset.value);
                              hideTargetDistanceHint();
                            }}
                            disabled={isRunning || isGeneratingAnyCourse}
                            className={`distance-preset-button rounded-lg px-3 py-2 text-xs font-black transition disabled:cursor-not-allowed ${
                              isActive
                                ? "liquid-selected-control"
                                : "liquid-clear-control"
                            }`}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>

                    <div className="relative">
                      <input
                        value={autoLoopTargetKm}
                        onChange={(event) => {
                          setAutoLoopTargetKm(event.target.value);
                          hideTargetDistanceHint();
                        }}
                        onFocus={hideTargetDistanceHint}
                        disabled={isRunning || isGeneratingAnyCourse}
                        inputMode="decimal"
                        className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 disabled:bg-slate-100"
                      />

                      {isTargetDistanceHintVisible && (
                        <button
                          type="button"
                          onClick={hideTargetDistanceHint}
                          className="target-distance-popover"
                        >
                          거리를 올바르게 입력해주십시오.
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-1 gap-2">
                    <button
                      type="button"
                      onClick={handleGenerateOutAndBackCandidates}
                      disabled={isGeneratedCourseControlsDisabled}
                      className="course-action-button course-action-primary px-3 py-2 text-xs disabled:cursor-not-allowed"
                    >
                      {isGeneratingAutoLoop ? "왕복 코스 찾는 중..." : "왕복 코스 찾기"}
                    </button>

                    <button
                      type="button"
                      onClick={handleGenerateOneWayCandidates}
                      disabled={isGeneratedCourseControlsDisabled}
                      className="course-action-button course-action-primary px-3 py-2 text-xs disabled:cursor-not-allowed"
                    >
                      {isGeneratingOneWay ? "편도 코스 찾는 중..." : "편도 코스 찾기"}
                    </button>

                    {isGeneratingAnyCourse && (
                      <button
                        type="button"
                        onClick={handleStopCourseSearch}
                        className="course-search-stop-button px-3 py-2 text-xs font-black"
                      >
                        코스 탐색 중지
                      </button>
                    )}
                  </div>

                  <div className="mt-2 text-[11px] text-slate-500">
                    왕복은 편도 끝지점까지 갔다가 같은 길로 돌아옵니다. 편도는 목표 거리만큼 한 방향으로 이동하는 후보를 찾습니다.
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    onClick={handleStartCustomCourseMode}
                    disabled={isCustomCourseStartDisabled}
                    className="course-action-button course-action-primary px-3 py-2 text-sm disabled:cursor-not-allowed"
                  >
                    직접 코스 만들기
                  </button>

                  <button
                    type="button"
                    onClick={handleStartDrawRouteMode}
                    disabled={isDrawRouteStartDisabled}
                    className="course-action-button course-action-primary px-3 py-2 text-sm disabled:cursor-not-allowed"
                  >
                    지도에 그려서 코스 찾기
                  </button>
                </div>

                {gpsActionError && (
                  <div className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700">
                    {gpsActionError}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-blue-100 bg-blue-50 p-3">
                <div className="text-sm font-bold text-slate-900">
                  러닝 준비
                </div>
                <div className="mt-1 text-xs text-slate-600">
                  코스를 고른 뒤 GPS 기록 방식과 가상 페이스메이커를 선택하고 시작하세요.
                </div>

                <div className="mt-3 rounded-xl border border-white/60 bg-white/35 p-2">
                  <div className="mb-2 text-xs font-black text-slate-900">
                    기록 방식
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setPlayerMode("gps")}
                      disabled={isRunning}
                      className={`liquid-choice-button rounded-xl px-3 py-3 text-sm font-black disabled:cursor-not-allowed ${
                        playerMode === "gps"
                          ? "liquid-selected-control"
                          : "liquid-clear-control"
                      }`}
                    >
                      GPS로 실제 달리기
                    </button>

                    <button
                      type="button"
                      onClick={() => setPlayerMode("pace")}
                      disabled={isRunning}
                      className={`liquid-choice-button rounded-xl px-3 py-3 text-sm font-black disabled:cursor-not-allowed ${
                        playerMode === "pace"
                          ? "liquid-selected-control"
                          : "liquid-clear-control"
                      }`}
                    >
                      페이스 입력 테스트
                    </button>
                  </div>

                  {playerMode === "gps" ? (
                    <div className="mt-2 text-[11px] font-semibold text-slate-500">
                      실제 위치 이동을 기준으로 거리와 페이스를 기록합니다.
                      {isGpsBlockedBySecurity && (
                        <span className="mt-1 block text-red-600">
                          GPS는 HTTPS 배포 주소 또는 localhost에서만 사용할 수 있습니다.
                        </span>
                      )}
                    </div>
                  ) : (
                    <label className="mt-2 block space-y-1">
                      <div className="text-[11px] font-semibold text-slate-500">
                        테스트용 내 페이스
                      </div>
                      <input
                        value={paceInput}
                        onChange={(event) => setPaceInput(event.target.value)}
                        disabled={isRunning}
                        placeholder="5:30"
                        className="w-full rounded-xl border border-white/60 bg-white/40 px-3 py-2 text-sm font-bold text-slate-900 outline-none disabled:cursor-not-allowed"
                      />
                      <div className="text-[11px] font-semibold text-slate-500">
                        입력 페이스: {formatPace(playerPaceSecPerKm)}
                      </div>
                    </label>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={handleOpenRunSettings}
                    disabled={!isMapLoaded || isRunning || !hasActiveCourse}
                    className="rounded-xl bg-blue-600 px-3 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    이 코스로 달리기
                  </button>

                  <button
                    type="button"
                    onClick={handleResetRace}
                    className="rounded-xl bg-white px-3 py-3 text-sm font-semibold text-slate-800 shadow-sm ring-1 ring-slate-200"
                  >
                    기록 초기화
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setActivePanel("map")}
                className="w-full rounded-xl bg-white px-3 py-3 text-sm font-semibold text-slate-800 shadow"
              >
                지도 보기
              </button>

              <button
                type="button"
                onClick={handleOpenFeedback}
                className="w-full rounded-xl border border-dashed border-slate-300 bg-white/80 px-3 py-3 text-sm font-semibold text-slate-700 shadow-sm"
              >
                피드백 보내기
              </button>

              {isTestPanelEnabled && (
                <div className="rounded-xl border border-purple-200 bg-purple-50 p-3">
                  <div className="text-sm font-black text-purple-950">
                    개발 테스트 패널
                  </div>
                  <div className="mt-1 text-xs text-purple-800">
                    로컬 개발 환경 또는 URL에 ?devtools=1을 붙였을 때만 표시됩니다.
                    실제 완주 없이 저장/즐겨찾기/완주 기록 흐름을 검수할 수 있습니다.
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={handleDevCompleteCurrentCourse}
                      disabled={!hasActiveCourse}
                      className="rounded-lg bg-purple-700 px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      현재 코스 테스트 완주
                    </button>

                    <button
                      type="button"
                      onClick={handleDevSeedCompletedCourses}
                      className="rounded-lg bg-purple-600 px-3 py-2 text-xs font-bold text-white"
                    >
                      테스트 기록 2개 생성
                    </button>

                    <button
                      type="button"
                      onClick={handleDevApplyShortCourse}
                      className="rounded-lg bg-white px-3 py-2 text-xs font-bold text-purple-800 ring-1 ring-purple-200"
                    >
                      짧은 테스트 코스 적용
                    </button>

                    <button
                      type="button"
                      onClick={handleDevClearLocalRecords}
                      className="rounded-lg bg-red-50 px-3 py-2 text-xs font-bold text-red-700 ring-1 ring-red-100"
                    >
                      저장 데이터 초기화
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activePanel === "setup" && setupView === "myCourses" && (
        <div className="race-panel race-setup-panel">
          <div className="mx-auto max-w-[560px] space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-2xl font-bold text-slate-900">
                  나의 코스
                </div>
                <div className="text-xs text-slate-500">
                  저장 코스와 완주 기록을 분리해 관리합니다.
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSetupView("main")}
                className="rounded-lg bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow"
              >
                뒤로
              </button>
            </div>

            <button
              type="button"
              onClick={handleStartCustomCourseMode}
              disabled={isRunning}
              className="w-full rounded-xl bg-blue-600 px-3 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              새 커스텀 코스 만들기
            </button>

            {favoriteCourseLibrary.length === 0 ? (
              <section className="rounded-3xl border border-dashed border-yellow-200 bg-gradient-to-br from-yellow-50 via-white to-orange-50 p-4 text-sm text-slate-700 shadow-sm">
                <div className="flex items-center gap-2 text-sm font-black text-slate-900">
                  <span>★</span>
                  <span>자주 뛸 코스</span>
                </div>
                <div className="mt-1 text-xs text-slate-600">
저장 코스에서 ☆ 버튼을 누르면 이곳에 빠른 실행 코스로 표시됩니다.
                </div>
              </section>
            ) : (
              <section className="rounded-3xl border border-yellow-200 bg-gradient-to-br from-yellow-50 via-white to-orange-50 p-3 shadow-sm">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-black text-slate-900">
                      <span>★</span>
                      <span>자주 뛸 코스</span>
                    </div>
                    <div className="text-xs text-slate-600">
즐겨찾기한 저장 코스를 빠르게 다시 불러옵니다.
                    </div>
                  </div>
                  <span className="rounded-full bg-yellow-400 px-2 py-1 text-[11px] font-black text-yellow-950">
                    {favoriteCourseLibrary.length}개
                  </span>
                </div>

                <div className="space-y-2">
                  {favoriteCourseLibrary.map((course) =>
                    renderStoredCourseCard(course, "favorite")
                  )}
                </div>
              </section>
            )}

            <section className="space-y-3">
              <div className="flex items-end justify-between gap-2 px-1">
                <div>
                  <div className="text-sm font-black text-slate-900">
                    저장 코스
                  </div>
                  <div className="text-xs text-slate-500">
                    직접 저장한 코스와 완주 후 자동 등록된 코스 원본입니다. 이 코스 단위로 즐겨찾기할 수 있습니다.
                  </div>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-600">
                  총 {sortedCourseLibrary.length}개
                </span>
              </div>

              {sortedCourseLibrary.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white/85 p-4 text-center text-sm text-slate-600 shadow-sm">
                  아직 저장 코스가 없습니다.
                  <button
                    type="button"
                    onClick={handleStartCustomCourseMode}
                    disabled={isRunning}
                    className="mt-3 block w-full rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    직접 코스 만들기
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {sortedCourseLibrary.map((course) =>
                    renderStoredCourseCard(course, "library")
                  )}
                </div>
              )}
            </section>

            <section className="space-y-3">
              <div className="flex items-end justify-between gap-2 px-1">
                <div>
                  <div className="text-sm font-black text-slate-900">
                    완주 기록
                  </div>
                  <div className="text-xs text-slate-500">
                    날짜별 전체 히스토리입니다. 완주 기록은 위 저장 코스 원본에 연결됩니다.
                  </div>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-600">
                  총 {sortedRunRecords.length}회
                </span>
              </div>

              {sortedRunRecords.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white/85 p-5 text-center shadow-sm">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-xl">
                    🏃
                  </div>
                  <div className="mt-3 text-sm font-black text-slate-900">
                    아직 완주 기록이 없습니다.
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    왕복 코스, 편도 코스 또는 커스텀 코스를 선택하고 한 번 완주하면 이곳에 기록이 자동으로 쌓입니다.
                  </div>
                  <button
                    type="button"
                    onClick={() => setSetupView("main")}
                    className="mt-4 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white"
                  >
                    코스 찾으러 가기
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {runRecordGroups.map((group) => (
                    <div key={group.dateLabel} className="space-y-2">
                      <div className="sticky top-20 z-10 rounded-full bg-slate-900 px-3 py-1.5 text-xs font-black text-white shadow-sm">
                        {group.dateLabel}
                      </div>

                      {group.records.map((record) =>
                        renderRunRecordCard(record)
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {activePanel === "map" && isAutoLoopPanelVisible && (
        <section
          className={`race-panel race-candidate-bottom-sheet ${
            isAutoLoopPanelCollapsed ? "race-candidate-bottom-sheet-collapsed" : ""
          }`}
          aria-label={`${candidateModeLabel} 후보 목록`}
          style={getBottomSheetDragStyle("candidate")}
        >
          <button
            type="button"
            className="candidate-bottom-sheet-handle bottom-sheet-drag-handle"
            aria-label="후보 패널 열기 또는 접기"
            onClick={() => handleBottomSheetHandleClick("candidate")}
            onPointerDown={(event) => handleBottomSheetDragStart("candidate", event)}
            onPointerMove={(event) => handleBottomSheetDragMove("candidate", event)}
            onPointerUp={(event) => handleBottomSheetDragEnd("candidate", event)}
            onPointerCancel={handleBottomSheetDragCancel}
          />

          <div className="candidate-bottom-sheet-header">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className="truncate text-sm font-black text-slate-900">
                  {candidateModeLabel} 후보
                </div>
                {previewingAutoLoopCandidate && (
                  <span className="shrink-0 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-black text-white">
                    미리보기
                  </span>
                )}
              </div>

              <div className="candidate-bottom-sheet-status">
                {isAutoLoopPanelCollapsed && previewingAutoLoopCandidate
                  ? `${previewingAutoLoopCandidate.name} · ${(
                      previewingAutoLoopCandidate.distanceM / 1000
                    ).toFixed(2)}km`
                  : status}
              </div>
            </div>

            <div className="candidate-bottom-sheet-actions bottom-sheet-icon-actions">
              {isDrawnCandidatePanel && !isGeneratingAnyCourse && (
                <button
                  type="button"
                  onClick={handleRestartDrawRouteAfterSearch}
                  className="candidate-sheet-control-button candidate-sheet-redraw-button"
                >
                  다시 그리기
                </button>
              )}

              {isGeneratingAnyCourse && (
                <button
                  type="button"
                  onClick={handleStopCourseSearch}
                  className="candidate-sheet-control-button candidate-sheet-stop-button"
                >
                  탐색 중지
                </button>
              )}

              <button
                type="button"
                onClick={() => setIsAutoLoopPanelCollapsed((value) => !value)}
                aria-label={isAutoLoopPanelCollapsed ? "후보 패널 열기" : "후보 패널 접기"}
                title={isAutoLoopPanelCollapsed ? "열기" : "접기"}
                className="bottom-sheet-icon-button"
              >
                {isAutoLoopPanelCollapsed ? "⌃" : "—"}
              </button>

              <button
                type="button"
                onClick={handleCloseAutoLoopPanel}
                aria-label="후보 패널 닫기"
                title="닫기"
                className="bottom-sheet-icon-button"
              >
                ×
              </button>
            </div>
          </div>

          {!isAutoLoopPanelCollapsed && (
            <div className="candidate-bottom-sheet-body">
              {isGeneratingAnyCourse && (
                <div className="candidate-sheet-info-card text-sm text-slate-700">
                  현재 위치와 주변 보행 경로를 기준으로 {candidateModeLabel} 후보를 탐색 중입니다.
                </div>
              )}

              {autoLoopError && (
                <div className="candidate-sheet-error-card text-sm text-red-700">
                  {autoLoopError}
                </div>
              )}

              {autoLoopCandidates.length > 0 && (
                <div className="space-y-2">
                  <div className="candidate-sheet-info-card text-xs text-slate-600">
                    표시 중: {autoLoopCandidateCursor - autoLoopCandidates.length + 1}
                    ~{autoLoopCandidateCursor} / {autoLoopAllCandidates.length}개 ·
                    남은 후보 {autoLoopRemainingCount}개
                  </div>

                  {autoLoopCandidates.map((candidate, index) => {
                    const isPreviewing =
                      autoLoopPreviewCandidateId === candidate.candidateId;
                    const summary = autoLoopElevationSummaries[candidate.candidateId];

                    return (
                      <div
                        key={candidate.candidateId}
                        className={`candidate-course-card ${
                          isPreviewing
                            ? "candidate-course-card-previewing"
                            : candidate.isWithinTolerance
                              ? "candidate-course-card-ok"
                              : "candidate-course-card-warning"
                        }`}
                      >
                        <div className="candidate-course-card-content">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2 text-sm font-black text-slate-900">
                              <span
                                className="inline-block h-3 w-3 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: getAutoLoopCandidateColor(index),
                                }}
                              />
                              <span className="truncate">{candidate.name}</span>
                              {isPreviewing && (
                                <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">
                                  미리보기 중
                                </span>
                              )}
                            </div>

                            <div className="mt-1 text-xs font-semibold text-slate-600">
                              거리 {(candidate.distanceM / 1000).toFixed(2)}km · 오차{" "}
                              {(candidate.distanceErrorM / 1000).toFixed(2)}km
                            </div>

                            {candidateMode === "outAndBack" && (
                              <div className="text-[11px] font-semibold text-orange-700">
                                편도 끝 반환점: {formatPoint(candidate.endpoint)}
                              </div>
                            )}

                            <div className="text-[11px] text-slate-500">
                              {candidate.isWithinTolerance
                                ? "허용 오차 ±0.5km 안"
                                : "허용 오차 밖"}
                            </div>

                            <div className="mt-1 text-[11px] font-semibold text-slate-700">
                              {formatElevationSummary(summary)}
                            </div>
                          </div>

                          <div className="candidate-course-card-actions">
                            <button
                              type="button"
                              onClick={() => handlePreviewAutoLoopCandidate(candidate, index)}
                              className={`candidate-card-action-button ${
                                isPreviewing
                                  ? "candidate-card-action-button-active"
                                  : ""
                              }`}
                            >
                              지도에서 보기
                            </button>

                            <button
                              type="button"
                              onClick={() => handleApplyAutoLoopCandidate(candidate)}
                              className="candidate-card-action-button candidate-card-action-button-primary"
                            >
                              이 코스로 달리기
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={handleShowMoreAutoLoopCandidates}
                      disabled={autoLoopRemainingCount <= 0}
                      className="candidate-sheet-footer-button candidate-sheet-footer-button-primary disabled:cursor-not-allowed"
                    >
                      후보 다시 찾기
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setActivePanel("setup");
                        setSetupView("main");
                      }}
                      className="candidate-sheet-footer-button"
                    >
                      설정으로
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {activePanel === "map" && isCustomCourseMode && (
        <section
          className={`race-panel race-custom-panel race-custom-bottom-sheet ${
            isCustomPanelCollapsed ? "race-custom-panel-collapsed" : ""
          }`}
          aria-label="커스텀 코스 생성"
          style={getBottomSheetDragStyle("custom")}
        >
          <button
            type="button"
            className="candidate-bottom-sheet-handle bottom-sheet-drag-handle"
            aria-label="커스텀 코스 패널 열기 또는 접기"
            onClick={() => handleBottomSheetHandleClick("custom")}
            onPointerDown={(event) => handleBottomSheetDragStart("custom", event)}
            onPointerMove={(event) => handleBottomSheetDragMove("custom", event)}
            onPointerUp={(event) => handleBottomSheetDragEnd("custom", event)}
            onPointerCancel={handleBottomSheetDragCancel}
          />

          <div className="custom-bottom-sheet-header">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-black text-slate-900">
                커스텀 코스 생성
              </div>
              <div className="text-xs font-semibold text-slate-500">
                {isCustomPanelCollapsed
                  ? `예상 길이 ${formatDraftDistance(customDraftDistanceM)}`
                  : customRouteMode === "outAndBack" && customPointStep === "finish"
                    ? "다음 선택: 반환점 겸 회차 지점"
                    : `다음 선택: ${getCustomStepLabel(customPointStep)}`}
              </div>
            </div>

            <div className="flex shrink-0 gap-1 bottom-sheet-icon-actions">
              <button
                type="button"
                onClick={() => setIsCustomPanelCollapsed((value) => !value)}
                aria-label={isCustomPanelCollapsed ? "커스텀 코스 패널 열기" : "커스텀 코스 패널 접기"}
                title={isCustomPanelCollapsed ? "열기" : "접기"}
                className="bottom-sheet-icon-button"
              >
                {isCustomPanelCollapsed ? "⌃" : "—"}
              </button>

              <button
                type="button"
                onClick={handleCancelCustomCourseMode}
                aria-label="커스텀 코스 닫기"
                title="닫기"
                className="bottom-sheet-icon-button"
              >
                ×
              </button>
            </div>
          </div>

          {!isCustomPanelCollapsed && (
            <div className="custom-bottom-sheet-body">
              <div className="custom-distance-summary-card">
                <div className="text-[11px] font-bold text-slate-500">
                  선택 지점 기준 예상 길이
                </div>
                <div className="mt-1 text-lg font-black text-slate-950">
                  {formatDraftDistance(customDraftDistanceM)}
                </div>
                <div className="mt-1 text-[11px] font-semibold text-slate-500">
                  시작점과 목표지점을 모두 고르면 즉시 계산됩니다. 왕복을 선택하면 시작점↔목표지점 거리를 2배로 계산합니다. 마커를 드래그하면 이 값도 실시간으로 바뀝니다. 실제 보행 경로 거리는 코스 생성 후 확정됩니다.
                </div>
              </div>

              <div className="custom-route-mode-toggle-card">
                <div className="mb-2 text-xs font-black text-slate-900">
                  코스 방식
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setCustomRouteMode("oneWay")}
                    disabled={isGeneratingCustomCourse}
                    className={`liquid-choice-button rounded-xl px-3 py-3 text-sm font-black disabled:cursor-not-allowed ${
                      customRouteMode === "oneWay"
                        ? "liquid-selected-control"
                        : "liquid-clear-control"
                    }`}
                  >
                    편도
                  </button>
                  <button
                    type="button"
                    onClick={() => setCustomRouteMode("outAndBack")}
                    disabled={isGeneratingCustomCourse}
                    className={`liquid-choice-button rounded-xl px-3 py-3 text-sm font-black disabled:cursor-not-allowed ${
                      customRouteMode === "outAndBack"
                        ? "liquid-selected-control"
                        : "liquid-clear-control"
                    }`}
                  >
                    왕복
                  </button>
                </div>
                <div className="mt-2 text-[11px] font-semibold text-slate-500">
                  편도는 시작점에서 목표지점까지, 왕복은 목표지점까지 갔다가 시작점으로 돌아오는 코스로 생성합니다.
                </div>
              </div>

              <div className="mb-3 rounded-lg bg-blue-50 p-2">
                <button
                  type="button"
                  onClick={handleUseCurrentLocationAsCustomStart}
                  disabled={
                    isRunning ||
                    isGeneratingCustomCourse ||
                    isCenteringOnCurrentLocation ||
                    Boolean(customPoints.finish)
                  }
                  className="w-full rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {isCenteringOnCurrentLocation ? "현재 위치 확인 중..." : "내 위치를 시작점으로"}
                </button>
                <div className="mt-1 text-[11px] text-blue-700">
                  GPS 상 현재 위치를 커스텀 코스의 시작지점으로 설정합니다. 종료지점이
                  이미 선택된 경우에는 전체 초기화 후 다시 설정하세요.
                </div>
              </div>

              <div className="space-y-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-700">
                {(["start", "finish"] as CustomPointStep[]).map((pointType) => {
                  const point = customPoints[pointType];
                  const pointLabel =
                    pointType === "finish" && customRouteMode === "outAndBack"
                      ? "반환점"
                      : getCustomPointLabel(pointType);

                  return (
                    <div
                      key={pointType}
                      className="flex items-center justify-between gap-2"
                    >
                      <div>
                        <span className="font-semibold">{pointLabel}:</span>{" "}
                        {formatPoint(point)}
                      </div>

                      <button
                        type="button"
                        onClick={() => removeCustomPoint(pointType)}
                        disabled={!point}
                        className="rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        취소
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 rounded-lg bg-slate-50 p-2">
                <label className="block space-y-1">
                  <div className="text-xs font-medium text-slate-600">
                    커스텀 코스 이름
                  </div>
                  <input
                    value={customCourseName}
                    onChange={(event) => setCustomCourseName(event.target.value)}
                    placeholder="예: 학교 앞 3K 왕복"
                    className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
                  />
                </label>

                <label className="mt-3 flex items-start gap-2 rounded-lg bg-white p-2 text-xs text-slate-700 ring-1 ring-slate-200">
                  <input
                    type="checkbox"
                    checked={shouldSaveCustomCourse}
                    onChange={(event) => setShouldSaveCustomCourse(event.target.checked)}
                    disabled={isGeneratingCustomCourse}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-bold text-slate-900">
                      나의 코스에 저장
                    </span>
                    <span className="block text-[11px] text-slate-500">
                      체크를 끄면 이번에 만든 코스만 지도에 적용하고, 목록에는 저장하지 않습니다.
                    </span>
                  </span>
                </label>
              </div>

              {customCourseError && (
                <div className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700">
                  {customCourseError}
                </div>
              )}

              <div className="custom-course-action-row mt-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={resetCustomCourseDraft}
                  className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
                >
                  전체 초기화
                </button>

                <button
                  type="button"
                  onClick={handleBuildCustomCourse}
                  disabled={!canBuildCustomCourse}
                  className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {isGeneratingCustomCourse
                    ? "생성 중..."
                    : shouldSaveCustomCourse
                      ? "커스텀 코스 저장"
                      : "저장 없이 코스 생성"}
                </button>
              </div>

              <div className="mt-2 text-[11px] text-slate-500">
                지도에서 시작점과 목표지점을 선택하세요. 편도는 목표지점에서 끝나고, 왕복은 목표지점에서 돌아와 시작점으로 종료됩니다. 저장 옵션을 켜면 나의 코스에서 다시 불러올 수 있습니다.
              </div>
            </div>
          )}
        </section>
      )}

      {activePanel === "map" && isDrawRouteMode && (
        <section
          className={`race-panel race-draw-bottom-sheet ${
            isDrawPanelCollapsed ? "race-draw-panel-collapsed" : ""
          }`}
          aria-label="코스 그리기"
          style={getBottomSheetDragStyle("draw")}
        >
          <button
            type="button"
            className="candidate-bottom-sheet-handle bottom-sheet-drag-handle"
            aria-label="코스 그리기 패널 열기 또는 접기"
            onClick={() => handleBottomSheetHandleClick("draw")}
            onPointerDown={(event) => handleBottomSheetDragStart("draw", event)}
            onPointerMove={(event) => handleBottomSheetDragMove("draw", event)}
            onPointerUp={(event) => handleBottomSheetDragEnd("draw", event)}
            onPointerCancel={handleBottomSheetDragCancel}
          />

          <div className="draw-bottom-sheet-header">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-black text-slate-900">
                코스 그리기
              </div>
              <div className="truncate text-xs font-semibold text-slate-500">
                {drawRouteInteractionMode === "move"
                  ? "지도 이동 모드 · 지도를 움직인 뒤 그리기로 돌아오세요."
                  : isGeneratingDrawRouteCandidates
                    ? `자동 후보 탐색 중 · 그린 길이 ${formatDraftDistance(drawnRouteDistanceM)}`
                    : drawnRouteDistanceM
                      ? `${isDrawingRoute ? "그리는 중 · " : "인식 완료 · "}그린 길이 ${formatDraftDistance(drawnRouteDistanceM)}`
                      : "한 손가락으로 그리고, 두 손가락으로 확대/축소할 수 있습니다."}
              </div>
            </div>

            <div className="flex shrink-0 gap-1 bottom-sheet-icon-actions">
              <button
                type="button"
                onClick={() => setIsDrawPanelCollapsed((value) => !value)}
                aria-label={isDrawPanelCollapsed ? "코스 그리기 패널 열기" : "코스 그리기 패널 접기"}
                title={isDrawPanelCollapsed ? "열기" : "접기"}
                className="bottom-sheet-icon-button"
              >
                {isDrawPanelCollapsed ? "⌃" : "—"}
              </button>

              <button
                type="button"
                onClick={handleCancelDrawRouteMode}
                aria-label="코스 그리기 닫기"
                title="닫기"
                className="bottom-sheet-icon-button"
              >
                ×
              </button>
            </div>
          </div>

          {!isDrawPanelCollapsed && (
            <div className="draw-bottom-sheet-body">
              <div className="draw-route-summary-card draw-route-summary-card-compact">
                <div className="text-[11px] font-bold text-slate-500">
                  그린 선 길이
                </div>
                <div className="mt-1 text-lg font-black text-slate-950">
                  {formatDraftDistance(drawnRouteDistanceM)}
                </div>
              </div>

              {drawRouteError && (
                <div className="mt-2 rounded-lg bg-red-50 p-2 text-xs font-bold text-red-700">
                  {drawRouteError}
                </div>
              )}

              <div className="draw-route-action-row grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleResetDrawRoute}
                  className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
                >
                  다시 그리기
                </button>

                {isGeneratingDrawRouteCandidates ? (
                  <button
                    type="button"
                    onClick={handleStopCourseSearch}
                    className="course-search-stop-button px-3 py-2 text-xs font-black"
                  >
                    탐색 중지
                  </button>
                ) : (
                  <div className="rounded-lg bg-white/55 px-3 py-2 text-center text-xs font-bold text-slate-500">
                    그리기 완료 시 자동 탐색
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {activePanel === "map" &&
        !isAutoLoopPanelVisible &&
        !isCustomCourseMode &&
        !isDrawRouteMode && (
        <section
          className={`race-panel race-map-hud race-map-bottom-sheet ${
            isLeaderboardOpen ? "race-map-hud-open" : "race-map-hud-collapsed"
          }`}
          aria-label="지도 러닝 정보"
          style={getBottomSheetDragStyle("mapHud")}
        >
          <button
            type="button"
            className="candidate-bottom-sheet-handle bottom-sheet-drag-handle"
            aria-label="지도 정보 패널 열기 또는 접기"
            onClick={() => handleBottomSheetHandleClick("mapHud")}
            onPointerDown={(event) => handleBottomSheetDragStart("mapHud", event)}
            onPointerMove={(event) => handleBottomSheetDragMove("mapHud", event)}
            onPointerUp={(event) => handleBottomSheetDragEnd("mapHud", event)}
            onPointerCancel={handleBottomSheetDragCancel}
          />

          <div className="map-bottom-sheet-header">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-black text-slate-900">
                {isRunning ? "Race Running" : "Map View"}
              </div>
              <div className="truncate text-xs font-semibold text-slate-500">
                {status}
              </div>
            </div>

            <div className="flex shrink-0 gap-1 bottom-sheet-icon-actions">
              <button
                type="button"
                onClick={() => setIsLeaderboardOpen((value) => !value)}
                aria-label={isLeaderboardOpen ? "지도 정보 패널 접기" : "지도 정보 패널 열기"}
                title={isLeaderboardOpen ? "접기" : "열기"}
                className="bottom-sheet-icon-button"
              >
                {isLeaderboardOpen ? "—" : "⌃"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setActivePanel("setup");
                  setSetupView("main");
                }}
                className="candidate-sheet-control-button bottom-sheet-text-control-button"
              >
                설정
              </button>
            </div>
          </div>

          {isLeaderboardOpen && (
            <div className="map-bottom-sheet-body">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-slate-50 p-2">
                  <div className="text-xs text-slate-500">Elapsed</div>
                  <div className="font-mono text-base font-semibold text-slate-900">
                    {elapsedSec.toFixed(1)}s
                  </div>
                </div>

                <div className="rounded-lg bg-slate-50 p-2">
                  <div className="text-xs text-slate-500">My Rank</div>
                  <div className="font-mono text-base font-semibold text-slate-900">
                    {playerRank || "-"} / {sortedHud.length || "-"}
                  </div>
                </div>

                <div className="rounded-lg bg-slate-50 p-2">
                  <div className="text-xs text-slate-500">Gap</div>
                  <div className="font-mono text-base font-semibold text-slate-900">
                    {playerRank <= 1 ? "Lead" : `${gapToAhead.toFixed(0)}m`}
                  </div>
                </div>
              </div>

              <div className="mt-2 text-xs text-slate-500">
                Course: {activeCourse.name} · length: {" "}
                {(courseLengthM / 1000).toFixed(2)} km
              </div>

              {activeCourseTurnaround && (
                <div className="mt-1 rounded-lg bg-orange-50 p-2 text-xs font-medium text-orange-700">
                  반환점: {formatPoint(activeCourseTurnaround)}
                </div>
              )}

              <div className="race-runner-list mt-2 space-y-2 overflow-y-auto">
                {sortedHud.map((runner, index) => (
                  <div
                    key={runner.id}
                    className={`rounded-lg border p-2 ${
                      runner.type === "player"
                        ? "border-green-300 bg-green-50"
                        : "border-slate-200 bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-slate-900">
                        {index + 1}. {runner.type === "player" ? "🏃" : "🤖"}{" "}
                        {runner.name}
                      </div>
                      <div className="text-xs text-slate-500">
                        {formatPace(runner.paceSecPerKm)}
                      </div>
                    </div>

                    <div className="mt-1 text-xs text-slate-600">
                      {(runner.distanceM / 1000).toFixed(2)} km · {" "}
                      {runner.progressPercent.toFixed(1)}%
                      {runner.finished ? " · Finished" : ""}
                    </div>

                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${
                          runner.type === "player" ? "bg-green-600" : "bg-blue-600"
                        }`}
                        style={{
                          width: `${Math.min(runner.progressPercent, 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleOpenRunSettings}
                  disabled={!isMapLoaded || isRunning || !hasActiveCourse}
                  className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  이 코스로 달리기
                </button>

                <button
                  type="button"
                  onClick={handleResetRace}
                  className="rounded-xl bg-slate-800 px-3 py-2 text-sm font-semibold text-white"
                >
                  Reset
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <style jsx global>{`
        html,
        body {
          margin: 0;
          padding: 0;
          background: #0f172a;
        }

        .race-root {
          position: fixed;
          inset: 0;
          width: 100vw;
          height: 100vh;
          height: 100dvh;
          overflow: hidden;
          background: #0f172a;
        }

        .setup-background {
          position: absolute;
          inset: 0;
          z-index: 20;
          overflow: hidden;
          background-image: none;
          background-size: cover;
          background-position: center 42%;
          background-repeat: no-repeat;
        }

        .setup-background::before,
        .setup-background::after {
          content: none;
        }

        .race-map {
          position: absolute;
          inset: 0;
          z-index: 1;
          width: 100%;
          height: 100%;
          background: #dbeafe;
        }

        .race-panel {
          position: absolute;
          z-index: 40;
          color: #0f172a;
          -webkit-overflow-scrolling: touch;
        }

        .race-setup-panel {
          inset: 0;
          overflow-y: auto;
          background: transparent;
          padding: calc(max(8px, env(safe-area-inset-top)) + 58px) 14px
            max(18px, env(safe-area-inset-bottom)) 14px;
        }

        .race-setup-panel > div {
          position: relative;
          z-index: 2;
        }

        .race-top-tabs {
          position: absolute;
          z-index: 50;
          top: max(8px, env(safe-area-inset-top));
          left: 10px;
          right: 10px;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }

        .race-tab-button {
          position: relative;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.32);
          border-radius: 16px;
          padding: 10px 12px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.22),
              rgba(255, 255, 255, 0.08)
            );
          color: rgba(255, 255, 255, 0.92);
          font-size: 14px;
          font-weight: 900;
          backdrop-filter: blur(22px) saturate(160%);
          -webkit-backdrop-filter: blur(22px) saturate(160%);
          box-shadow:
            0 12px 30px rgba(0, 0, 0, 0.18),
            inset 0 1px 0 rgba(255, 255, 255, 0.24);
        }

        .race-tab-active {
          border-color: rgba(255, 255, 255, 0.42);
          background:
            linear-gradient(
              135deg,
              rgba(16, 18, 24, 0.72),
              rgba(49, 39, 32, 0.48)
            );
          color: white;
        }

        .liquid-glass,
        .hero-glass-card,
        .race-setup-panel .rounded-xl.border,
        .race-setup-panel .rounded-lg.border,
        .race-setup-panel .rounded-xl[class*="border"],
        .race-setup-panel .rounded-lg[class*="border"],
        .run-settings-panel,
        .race-map-hud,
        .race-custom-panel,
        .race-auto-loop-panel,
        .custom-guide-toast,
        .target-distance-popover {
          position: relative;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.34) !important;
          backdrop-filter: blur(24px) saturate(160%);
          -webkit-backdrop-filter: blur(24px) saturate(160%);
          box-shadow:
            0 22px 54px rgba(0, 0, 0, 0.20),
            inset 0 1px 0 rgba(255, 255, 255, 0.32),
            inset 0 -1px 0 rgba(255, 255, 255, 0.08) !important;
        }

        .liquid-glass::before,
        .hero-glass-card::before,
        .race-setup-panel .rounded-xl.border::before,
        .race-setup-panel .rounded-lg.border::before,
        .race-setup-panel .rounded-xl[class*="border"]::before,
        .race-setup-panel .rounded-lg[class*="border"]::before,
        .run-settings-panel::before,
        .race-map-hud::before,
        .race-custom-panel::before,
        .race-auto-loop-panel::before,
        .custom-guide-toast::before,
        .target-distance-popover::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 0;
          background:
            radial-gradient(
              circle at 20% 0%,
              rgba(255, 255, 255, 0.22),
              transparent 38%
            ),
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.16),
              transparent 46%
            );
          pointer-events: none;
        }

        .liquid-glass > *,
        .hero-glass-card > *,
        .race-setup-panel .rounded-xl.border > *,
        .race-setup-panel .rounded-lg.border > *,
        .race-setup-panel .rounded-xl[class*="border"] > *,
        .race-setup-panel .rounded-lg[class*="border"] > *,
        .run-settings-panel > *,
        .race-map-hud > *,
        .race-custom-panel > *,
        .race-auto-loop-panel > *,
        .custom-guide-toast > *,
        .target-distance-popover > * {
          position: relative;
          z-index: 1;
        }

        .hero-glass-card {
          border-color: rgba(255, 255, 255, 0.38) !important;
          background:
            linear-gradient(
              135deg,
              rgba(16, 18, 24, 0.66),
              rgba(56, 45, 36, 0.42)
            ) !important;
          color: rgba(255, 255, 255, 0.97) !important;
          backdrop-filter: blur(28px) saturate(165%);
          -webkit-backdrop-filter: blur(28px) saturate(165%);
        }

        .race-setup-panel .rounded-xl.border:not(.hero-glass-card),
        .race-setup-panel .rounded-lg.border:not(.hero-glass-card),
        .race-setup-panel .rounded-xl[class*="border"]:not(.hero-glass-card),
        .race-setup-panel .rounded-lg[class*="border"]:not(.hero-glass-card) {
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.34),
              rgba(255, 255, 255, 0.13)
            ) !important;
          color: #0f172a !important;
        }

        .race-setup-panel .rounded-xl.border:not(.hero-glass-card) .text-slate-950,
        .race-setup-panel .rounded-xl.border:not(.hero-glass-card) .text-slate-900,
        .race-setup-panel .rounded-xl.border:not(.hero-glass-card) .text-slate-800,
        .race-setup-panel .rounded-xl.border:not(.hero-glass-card) .text-slate-700,
        .race-setup-panel .rounded-lg.border:not(.hero-glass-card) .text-slate-950,
        .race-setup-panel .rounded-lg.border:not(.hero-glass-card) .text-slate-900,
        .race-setup-panel .rounded-lg.border:not(.hero-glass-card) .text-slate-800,
        .race-setup-panel .rounded-lg.border:not(.hero-glass-card) .text-slate-700 {
          color: #0f172a !important;
        }

        .race-setup-panel .rounded-xl.border:not(.hero-glass-card) .text-slate-600,
        .race-setup-panel .rounded-xl.border:not(.hero-glass-card) .text-slate-500,
        .race-setup-panel .rounded-xl.border:not(.hero-glass-card) .text-slate-400,
        .race-setup-panel .rounded-lg.border:not(.hero-glass-card) .text-slate-600,
        .race-setup-panel .rounded-lg.border:not(.hero-glass-card) .text-slate-500,
        .race-setup-panel .rounded-lg.border:not(.hero-glass-card) .text-slate-400 {
          color: rgba(51, 65, 85, 0.78) !important;
        }

        .race-setup-panel .bg-white,
        .race-setup-panel [class*="bg-white/"],
        .race-setup-panel .bg-slate-50,
        .race-setup-panel .bg-slate-100,
        .race-setup-panel .bg-blue-50,
        .race-setup-panel .bg-indigo-50,
        .race-setup-panel .bg-purple-50,
        .race-setup-panel .bg-violet-50,
        .race-setup-panel .bg-emerald-50,
        .race-setup-panel .bg-green-50,
        .race-setup-panel .bg-orange-50,
        .race-setup-panel .bg-yellow-50,
        .race-setup-panel .bg-red-50,
        .run-settings-panel .bg-white,
        .run-settings-panel .bg-slate-50,
        .run-settings-panel .bg-blue-50,
        .run-settings-panel .bg-orange-50 {
          border: 1px solid rgba(255, 255, 255, 0.30) !important;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.24),
              rgba(255, 255, 255, 0.08)
            ) !important;
          color: #0f172a !important;
          backdrop-filter: blur(20px) saturate(150%);
          -webkit-backdrop-filter: blur(20px) saturate(150%);
          box-shadow:
            0 10px 28px rgba(0, 0, 0, 0.10),
            inset 0 1px 0 rgba(255, 255, 255, 0.30) !important;
        }

        .race-setup-panel input,
        .run-settings-panel input {
          border-color: rgba(255, 255, 255, 0.42) !important;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.30),
              rgba(255, 255, 255, 0.12)
            ) !important;
          color: #0f172a !important;
          backdrop-filter: blur(18px) saturate(145%);
          -webkit-backdrop-filter: blur(18px) saturate(145%);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.38),
            0 8px 22px rgba(0, 0, 0, 0.08) !important;
        }

        .race-setup-panel input::placeholder,
        .run-settings-panel input::placeholder {
          color: rgba(51, 65, 85, 0.68) !important;
        }

        .race-setup-panel button,
        .run-settings-panel button,
        .race-map-hud button,
        .race-custom-panel button,
        .race-auto-loop-panel button,
        .map-location-button,
        .custom-guide-close {
          transform: translateY(0) scale(1);
          transition:
            transform 140ms ease,
            box-shadow 140ms ease,
            filter 140ms ease,
            background-color 140ms ease,
            border-color 140ms ease;
          will-change: transform;
        }

        .race-setup-panel button:active:not(:disabled),
        .run-settings-panel button:active:not(:disabled),
        .race-map-hud button:active:not(:disabled),
        .race-custom-panel button:active:not(:disabled),
        .race-auto-loop-panel button:active:not(:disabled),
        .map-location-button:active:not(:disabled),
        .custom-guide-close:active:not(:disabled) {
          transform: translateY(1px) scale(0.972);
          filter: brightness(0.94);
        }

        .course-action-button,
        .course-action-primary,
        .race-setup-panel button.bg-green-600,
        .race-setup-panel button.bg-blue-600,
        .race-setup-panel button.bg-indigo-600,
        .race-setup-panel button.bg-slate-800,
        .run-settings-panel button.bg-blue-600,
        .run-settings-panel button.bg-slate-800 {
          position: relative;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.32) !important;
          border-radius: 18px;
          background:
            linear-gradient(
              135deg,
              rgba(16, 18, 24, 0.68),
              rgba(56, 45, 36, 0.42)
            ) !important;
          color: rgba(255, 255, 255, 0.98) !important;
          font-weight: 900;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
          backdrop-filter: blur(26px) saturate(160%);
          -webkit-backdrop-filter: blur(26px) saturate(160%);
          box-shadow:
            0 16px 40px rgba(0, 0, 0, 0.22),
            inset 0 1px 0 rgba(255, 255, 255, 0.24),
            inset 0 -1px 0 rgba(255, 255, 255, 0.08) !important;
        }

        .course-action-button::before,
        .course-action-primary::before,
        .race-setup-panel button.bg-green-600::before,
        .race-setup-panel button.bg-blue-600::before,
        .race-setup-panel button.bg-indigo-600::before,
        .race-setup-panel button.bg-slate-800::before,
        .run-settings-panel button.bg-blue-600::before,
        .run-settings-panel button.bg-slate-800::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 0;
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.18),
              rgba(255, 255, 255, 0.04) 42%,
              transparent 72%
            );
          pointer-events: none;
        }

        .course-action-button > *,
        .course-action-primary > *,
        .race-setup-panel button.bg-green-600 > *,
        .race-setup-panel button.bg-blue-600 > *,
        .race-setup-panel button.bg-indigo-600 > *,
        .race-setup-panel button.bg-slate-800 > *,
        .run-settings-panel button.bg-blue-600 > *,
        .run-settings-panel button.bg-slate-800 > * {
          position: relative;
          z-index: 1;
        }

        .course-action-button:hover:not(:disabled),
        .course-action-primary:hover:not(:disabled) {
          filter: brightness(1.06) saturate(1.03);
          border-color: rgba(255, 255, 255, 0.44) !important;
        }

        .race-setup-panel button.bg-white,
        .race-setup-panel button.bg-slate-100,
        .race-setup-panel button[class*="bg-white/"],
        .race-setup-panel button[class*="border-dashed"],
        .run-settings-panel button.bg-white,
        .run-settings-panel button.bg-slate-100,
        .race-map-hud button.bg-slate-100,
        .race-custom-panel button.bg-slate-100,
        .race-auto-loop-panel button.bg-slate-100 {
          border: 1px solid rgba(255, 255, 255, 0.34) !important;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.18),
              rgba(255, 255, 255, 0.07)
            ) !important;
          color: #0f172a !important;
          backdrop-filter: blur(22px) saturate(155%);
          -webkit-backdrop-filter: blur(22px) saturate(155%);
          box-shadow:
            0 12px 30px rgba(0, 0, 0, 0.12),
            inset 0 1px 0 rgba(255, 255, 255, 0.32) !important;
        }

        .race-setup-panel button[class*="bg-slate-900"],
        .race-setup-panel button[class*="bg-slate-950"],
        .race-setup-panel button[class*="bg-slate-800"],
        .run-settings-panel button[class*="bg-slate-900"],
        .run-settings-panel button[class*="bg-slate-950"],
        .run-settings-panel button[class*="bg-slate-800"] {
          border: 1px solid rgba(255, 255, 255, 0.34) !important;
          background:
            linear-gradient(
              135deg,
              rgba(16, 18, 24, 0.70),
              rgba(56, 45, 36, 0.42)
            ) !important;
          color: rgba(255, 255, 255, 0.98) !important;
          backdrop-filter: blur(26px) saturate(160%);
          -webkit-backdrop-filter: blur(26px) saturate(160%);
          box-shadow:
            0 16px 40px rgba(0, 0, 0, 0.22),
            inset 0 1px 0 rgba(255, 255, 255, 0.24) !important;
        }

        .race-setup-panel button:disabled,
        .run-settings-panel button:disabled,
        .race-map-hud button:disabled,
        .race-custom-panel button:disabled,
        .race-auto-loop-panel button:disabled {
          border-color: rgba(255, 255, 255, 0.22) !important;
          background:
            linear-gradient(
              135deg,
              rgba(226, 232, 240, 0.28),
              rgba(255, 255, 255, 0.09)
            ) !important;
          color: rgba(71, 85, 105, 0.58) !important;
          text-shadow: none;
          backdrop-filter: blur(18px) saturate(125%);
          -webkit-backdrop-filter: blur(18px) saturate(125%);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.20),
            0 8px 20px rgba(0, 0, 0, 0.08) !important;
        }

        .run-settings-backdrop {
          position: absolute;
          inset: 0;
          z-index: 70;
          display: flex;
          align-items: flex-end;
          justify-content: center;
          background: rgba(15, 23, 42, 0.34);
          padding: 12px 10px max(10px, env(safe-area-inset-bottom)) 10px;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }

        .run-settings-panel {
          width: 100%;
          max-width: 560px;
          max-height: min(84vh, 680px);
          overflow-y: auto;
          border-radius: 24px 24px 18px 18px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.34),
              rgba(255, 255, 255, 0.14)
            ) !important;
          padding: 14px;
          -webkit-overflow-scrolling: touch;
        }

        .race-map-hud,
        .race-custom-panel,
        .race-auto-loop-panel {
          left: 10px;
          right: 10px;
          bottom: max(10px, env(safe-area-inset-bottom));
          overflow-y: auto;
          border-radius: 22px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.34),
              rgba(255, 255, 255, 0.14)
            ) !important;
          padding: 12px;
        }

        .race-map-hud-open {
          max-height: min(54vh, 420px);
        }

        .race-map-hud-collapsed {
          max-height: 176px;
        }

        .race-custom-panel {
          max-height: min(62vh, 500px);
        }

        .race-auto-loop-panel {
          max-height: min(66vh, 560px);
        }

        .race-auto-loop-panel-collapsed {
          max-height: 104px;
          overflow: hidden;
        }

        .race-runner-list {
          max-height: 210px;
        }

        .map-location-control {
          position: absolute;
          z-index: 55;
          top: calc(max(8px, env(safe-area-inset-top)) + 54px);
          right: 10px;
          display: flex;
          max-width: min(78vw, 330px);
          flex-direction: column;
          align-items: flex-end;
          gap: 4px;
        }

        .map-location-button {
          border: 1px solid rgba(255, 255, 255, 0.32);
          border-radius: 9999px;
          background:
            linear-gradient(
              135deg,
              rgba(16, 18, 24, 0.70),
              rgba(56, 45, 36, 0.42)
            );
          color: white;
          padding: 10px 14px;
          font-size: 13px;
          font-weight: 900;
          backdrop-filter: blur(22px) saturate(155%);
          -webkit-backdrop-filter: blur(22px) saturate(155%);
          box-shadow:
            0 14px 34px rgba(0, 0, 0, 0.22),
            inset 0 1px 0 rgba(255, 255, 255, 0.22);
        }

        .map-location-meta {
          border: 1px solid rgba(255, 255, 255, 0.28);
          border-radius: 9999px;
          background: rgba(255, 255, 255, 0.18);
          color: #0f172a;
          padding: 4px 8px;
          font-size: 10px;
          font-weight: 800;
          backdrop-filter: blur(16px) saturate(145%);
          -webkit-backdrop-filter: blur(16px) saturate(145%);
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
        }

        .map-location-meta-error {
          color: #b91c1c;
          background: rgba(254, 242, 242, 0.62);
        }

        .custom-guide-toast {
          position: absolute;
          z-index: 60;
          top: calc(max(8px, env(safe-area-inset-top)) + 54px);
          left: 10px;
          right: 10px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          border-radius: 18px;
          background:
            linear-gradient(
              135deg,
              rgba(16, 18, 24, 0.76),
              rgba(56, 45, 36, 0.48)
            ) !important;
          color: white;
          padding: 12px 14px;
        }

        .custom-guide-text {
          font-size: 14px;
          font-weight: 800;
          line-height: 1.35;
        }

        .custom-guide-close {
          border: 1px solid rgba(255, 255, 255, 0.24);
          border-radius: 9999px;
          width: 28px;
          height: 28px;
          background: rgba(255, 255, 255, 0.12);
          color: white;
          font-size: 20px;
          line-height: 1;
          font-weight: 800;
        }

        .target-distance-popover {
          position: absolute;
          left: 10px;
          top: calc(100% + 10px);
          z-index: 80;
          max-width: min(270px, calc(100vw - 44px));
          border-radius: 16px;
          background:
            linear-gradient(
              135deg,
              rgba(16, 18, 24, 0.86),
              rgba(56, 45, 36, 0.62)
            ) !important;
          color: rgba(255, 255, 255, 0.96);
          padding: 10px 12px;
          text-align: left;
          font-size: 12px;
          font-weight: 900;
          line-height: 1.35;
        }

        .target-distance-popover::after {
          content: "";
          position: absolute;
          top: -6px;
          left: 18px;
          width: 12px;
          height: 12px;
          transform: rotate(45deg);
          border-left: 1px solid rgba(255, 255, 255, 0.32);
          border-top: 1px solid rgba(255, 255, 255, 0.32);
          background: rgba(16, 18, 24, 0.82);
        }



        /* =========================================================
           Bright Liquid Glass redesign
           - White / soft-gray background, no photo background
           - Light glass cards and controls
           - Color appears only as subtle accent, not heavy CTA blocks
           ========================================================= */
        html,
        body {
          background:
            radial-gradient(circle at 18% 10%, rgba(255, 255, 255, 0.98), transparent 34%),
            radial-gradient(circle at 78% 18%, rgba(219, 234, 254, 0.56), transparent 30%),
            radial-gradient(circle at 18% 84%, rgba(220, 252, 231, 0.40), transparent 30%),
            linear-gradient(135deg, #f8fafc 0%, #eef2f7 48%, #f7fbff 100%) !important;
        }

        .race-root {
          background:
            radial-gradient(circle at 12% 8%, rgba(255, 255, 255, 0.96), transparent 34%),
            radial-gradient(circle at 86% 13%, rgba(191, 219, 254, 0.52), transparent 28%),
            radial-gradient(circle at 24% 90%, rgba(187, 247, 208, 0.38), transparent 30%),
            linear-gradient(135deg, #f8fafc 0%, #eef2f7 44%, #f7fbff 100%) !important;
        }

        .setup-background {
          position: absolute;
          inset: 0;
          z-index: 20;
          overflow: hidden;
          background:
            radial-gradient(circle at 10% 10%, rgba(255, 255, 255, 0.95), transparent 34%),
            radial-gradient(circle at 86% 16%, rgba(125, 211, 252, 0.24), transparent 28%),
            radial-gradient(circle at 15% 88%, rgba(134, 239, 172, 0.22), transparent 32%),
            radial-gradient(circle at 74% 82%, rgba(251, 207, 232, 0.18), transparent 34%),
            linear-gradient(135deg, #f8fafc 0%, #edf2f8 48%, #fbfdff 100%) !important;
          background-image: none !important;
        }

        .setup-background::before {
          content: "";
          position: absolute;
          inset: -20%;
          z-index: 0;
          background:
            linear-gradient(115deg, transparent 0 17%, rgba(255, 255, 255, 0.56) 18% 19%, transparent 20% 100%),
            linear-gradient(25deg, transparent 0 58%, rgba(255, 255, 255, 0.32) 59% 60%, transparent 61% 100%);
          filter: blur(1px);
          opacity: 0.72;
          pointer-events: none;
        }

        .setup-background::after {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 0;
          background:
            radial-gradient(circle at 50% -10%, rgba(255, 255, 255, 0.78), transparent 38%),
            linear-gradient(to bottom, rgba(255, 255, 255, 0.10), rgba(255, 255, 255, 0.36));
          pointer-events: none;
        }

        .race-top-tabs {
          gap: 10px;
        }

        .race-tab-button {
          border: 1px solid rgba(255, 255, 255, 0.78) !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.70), rgba(255, 255, 255, 0.28)) !important;
          color: rgba(15, 23, 42, 0.84) !important;
          backdrop-filter: blur(22px) saturate(170%) !important;
          -webkit-backdrop-filter: blur(22px) saturate(170%) !important;
          box-shadow:
            0 16px 35px rgba(15, 23, 42, 0.10),
            inset 0 1px 0 rgba(255, 255, 255, 0.88),
            inset 0 -1px 0 rgba(255, 255, 255, 0.34) !important;
        }

        .race-tab-active {
          background:
            linear-gradient(135deg, rgba(15, 23, 42, 0.88), rgba(36, 45, 62, 0.60)) !important;
          color: rgba(255, 255, 255, 0.98) !important;
          border-color: rgba(255, 255, 255, 0.58) !important;
          box-shadow:
            0 18px 40px rgba(15, 23, 42, 0.18),
            inset 0 1px 0 rgba(255, 255, 255, 0.28) !important;
        }

        /* Core liquid material */
        .hero-glass-card,
        .race-setup-panel .rounded-xl.border,
        .race-setup-panel .rounded-lg.border,
        .race-setup-panel .rounded-xl[class*="border"],
        .race-setup-panel .rounded-lg[class*="border"],
        .run-settings-panel,
        .race-map-hud,
        .race-custom-panel,
        .race-auto-loop-panel,
        .target-distance-popover {
          position: relative;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.74) !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0.24)) !important;
          color: #0f172a !important;
          backdrop-filter: blur(28px) saturate(185%) !important;
          -webkit-backdrop-filter: blur(28px) saturate(185%) !important;
          box-shadow:
            0 22px 55px rgba(15, 23, 42, 0.12),
            inset 0 1px 0 rgba(255, 255, 255, 0.92),
            inset 0 -1px 0 rgba(255, 255, 255, 0.34) !important;
        }

        .hero-glass-card {
          border-radius: 32px !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.74), rgba(255, 255, 255, 0.30)) !important;
          box-shadow:
            0 28px 70px rgba(15, 23, 42, 0.14),
            inset 0 1px 0 rgba(255, 255, 255, 0.96),
            inset 0 -1px 0 rgba(255, 255, 255, 0.40) !important;
        }

        .hero-glass-card::before,
        .race-setup-panel .rounded-xl.border::before,
        .race-setup-panel .rounded-lg.border::before,
        .race-setup-panel .rounded-xl[class*="border"]::before,
        .race-setup-panel .rounded-lg[class*="border"]::before,
        .run-settings-panel::before,
        .race-map-hud::before,
        .race-custom-panel::before,
        .race-auto-loop-panel::before,
        .target-distance-popover::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 0;
          background:
            radial-gradient(circle at 14% 0%, rgba(255, 255, 255, 0.72), transparent 36%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.42), transparent 42%),
            radial-gradient(circle at 86% 100%, rgba(191, 219, 254, 0.16), transparent 34%);
          pointer-events: none;
        }

        .hero-glass-card > *,
        .race-setup-panel .rounded-xl.border > *,
        .race-setup-panel .rounded-lg.border > *,
        .race-setup-panel .rounded-xl[class*="border"] > *,
        .race-setup-panel .rounded-lg[class*="border"] > *,
        .run-settings-panel > *,
        .race-map-hud > *,
        .race-custom-panel > *,
        .race-auto-loop-panel > *,
        .target-distance-popover > * {
          position: relative;
          z-index: 1;
        }

        /* Force hero typography into bright UI, even if JSX has text-white utilities. */
        .hero-glass-card,
        .hero-glass-card .text-white,
        .hero-glass-card .text-slate-50,
        .hero-glass-card .text-slate-100 {
          color: #0f172a !important;
          text-shadow: none !important;
        }

        .hero-glass-card .tracking-\[0\.32em\],
        .hero-glass-card [class*="tracking-"] {
          color: rgba(5, 150, 105, 0.88) !important;
          text-shadow: none !important;
        }

        .race-setup-panel .text-white,
        .race-setup-panel .text-slate-50,
        .race-setup-panel .text-slate-100,
        .race-setup-panel .text-slate-900,
        .race-setup-panel .text-slate-800,
        .race-setup-panel .text-slate-700,
        .race-setup-panel .text-slate-600,
        .race-setup-panel .text-slate-500,
        .race-setup-panel .text-slate-400 {
          color: #0f172a !important;
        }

        .race-setup-panel .text-slate-500,
        .race-setup-panel .text-slate-400,
        .race-setup-panel .text-xs,
        .race-setup-panel .text-\[11px\],
        .race-setup-panel .text-\[10px\] {
          color: rgba(51, 65, 85, 0.78) !important;
        }

        /* Inner surfaces */
        .race-setup-panel .bg-white,
        .race-setup-panel [class*="bg-white/"],
        .race-setup-panel .bg-slate-50,
        .race-setup-panel .bg-slate-100,
        .race-setup-panel .bg-blue-50,
        .race-setup-panel .bg-indigo-50,
        .race-setup-panel .bg-purple-50,
        .race-setup-panel .bg-violet-50,
        .race-setup-panel .bg-emerald-50,
        .race-setup-panel .bg-green-50,
        .race-setup-panel .bg-orange-50,
        .race-setup-panel .bg-yellow-50,
        .race-setup-panel .bg-red-50,
        .run-settings-panel .bg-white,
        .run-settings-panel .bg-slate-50,
        .run-settings-panel .bg-blue-50,
        .run-settings-panel .bg-orange-50 {
          border: 1px solid rgba(255, 255, 255, 0.62) !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.52), rgba(255, 255, 255, 0.18)) !important;
          color: #0f172a !important;
          backdrop-filter: blur(22px) saturate(170%) !important;
          -webkit-backdrop-filter: blur(22px) saturate(170%) !important;
          box-shadow:
            0 12px 30px rgba(15, 23, 42, 0.08),
            inset 0 1px 0 rgba(255, 255, 255, 0.82) !important;
        }

        .race-setup-panel input,
        .run-settings-panel input {
          border-color: rgba(255, 255, 255, 0.72) !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.58), rgba(255, 255, 255, 0.22)) !important;
          color: #0f172a !important;
          backdrop-filter: blur(18px) saturate(170%) !important;
          -webkit-backdrop-filter: blur(18px) saturate(170%) !important;
          box-shadow:
            0 10px 24px rgba(15, 23, 42, 0.08),
            inset 0 1px 0 rgba(255, 255, 255, 0.84) !important;
        }

        .race-setup-panel input::placeholder,
        .run-settings-panel input::placeholder {
          color: rgba(51, 65, 85, 0.62) !important;
        }

        /* Liquid buttons: default bright/clear */
        .race-setup-panel button,
        .run-settings-panel button,
        .race-map-hud button,
        .race-custom-panel button,
        .race-auto-loop-panel button,
        .map-location-button,
        .custom-guide-close {
          border: 1px solid rgba(255, 255, 255, 0.66) !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.58), rgba(255, 255, 255, 0.20)) !important;
          color: #0f172a !important;
          backdrop-filter: blur(22px) saturate(175%) !important;
          -webkit-backdrop-filter: blur(22px) saturate(175%) !important;
          box-shadow:
            0 14px 32px rgba(15, 23, 42, 0.10),
            inset 0 1px 0 rgba(255, 255, 255, 0.82),
            inset 0 -1px 0 rgba(255, 255, 255, 0.28) !important;
          text-shadow: none !important;
          transform: translateY(0) scale(1);
          transition:
            transform 140ms ease,
            box-shadow 140ms ease,
            filter 140ms ease,
            background 140ms ease,
            border-color 140ms ease;
          will-change: transform;
        }

        /* Primary CTAs are still bright glass, with dark text, not heavy blocks. */
        .course-action-button,
        .course-action-primary,
        .race-setup-panel button.bg-green-600,
        .race-setup-panel button.bg-blue-600,
        .race-setup-panel button.bg-indigo-600,
        .run-settings-panel button.bg-blue-600 {
          border-color: rgba(255, 255, 255, 0.78) !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.74), rgba(255, 255, 255, 0.30)) !important;
          color: #0f172a !important;
          font-weight: 950;
          box-shadow:
            0 18px 42px rgba(15, 23, 42, 0.14),
            inset 0 1px 0 rgba(255, 255, 255, 0.96),
            inset 0 -1px 0 rgba(255, 255, 255, 0.32) !important;
        }

        .course-action-button::before,
        .course-action-primary::before,
        .race-setup-panel button.bg-green-600::before,
        .race-setup-panel button.bg-blue-600::before,
        .race-setup-panel button.bg-indigo-600::before,
        .run-settings-panel button.bg-blue-600::before,
        .race-setup-panel button::before,
        .run-settings-panel button::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 0;
          border-radius: inherit;
          background:
            radial-gradient(circle at 24% 0%, rgba(255, 255, 255, 0.72), transparent 38%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.40), transparent 48%);
          pointer-events: none;
        }

        .race-setup-panel button > *,
        .run-settings-panel button > *,
        .course-action-button > *,
        .course-action-primary > * {
          position: relative;
          z-index: 1;
        }

        .race-setup-panel button:active:not(:disabled),
        .run-settings-panel button:active:not(:disabled),
        .race-map-hud button:active:not(:disabled),
        .race-custom-panel button:active:not(:disabled),
        .race-auto-loop-panel button:active:not(:disabled),
        .map-location-button:active:not(:disabled),
        .custom-guide-close:active:not(:disabled) {
          transform: translateY(1px) scale(0.972) !important;
          filter: brightness(0.96) saturate(0.96) !important;
          box-shadow:
            0 8px 18px rgba(15, 23, 42, 0.12),
            inset 0 3px 12px rgba(15, 23, 42, 0.10),
            inset 0 1px 0 rgba(255, 255, 255, 0.52) !important;
        }

        .race-setup-panel button:disabled,
        .run-settings-panel button:disabled,
        .race-map-hud button:disabled,
        .race-custom-panel button:disabled,
        .race-auto-loop-panel button:disabled {
          border-color: rgba(255, 255, 255, 0.48) !important;
          background:
            linear-gradient(135deg, rgba(226, 232, 240, 0.46), rgba(255, 255, 255, 0.16)) !important;
          color: rgba(71, 85, 105, 0.56) !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.56),
            0 8px 18px rgba(15, 23, 42, 0.06) !important;
        }

        .run-settings-backdrop {
          background: rgba(248, 250, 252, 0.44) !important;
          backdrop-filter: blur(18px) saturate(170%) !important;
          -webkit-backdrop-filter: blur(18px) saturate(170%) !important;
        }

        .run-settings-panel,
        .race-map-hud,
        .race-custom-panel,
        .race-auto-loop-panel {
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.66), rgba(255, 255, 255, 0.26)) !important;
        }

        .custom-guide-toast,
        .target-distance-popover {
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0.34)) !important;
          color: #0f172a !important;
          border-color: rgba(255, 255, 255, 0.72) !important;
        }

        .target-distance-popover::after {
          background: rgba(255, 255, 255, 0.70) !important;
          border-color: rgba(255, 255, 255, 0.72) !important;
        }


        @media (orientation: landscape) and (max-height: 560px) {
          .race-top-tabs {
            left: 10px;
            right: auto;
            width: min(390px, 42vw);
            grid-template-columns: 1fr 1fr;
          }

          .custom-guide-toast {
            left: calc(min(390px, 42vw) + 20px);
            right: 10px;
            top: max(8px, env(safe-area-inset-top));
          }

          .map-location-control {
            top: max(8px, env(safe-area-inset-top));
            right: 10px;
            max-width: min(46vw, 330px);
          }

          .race-setup-panel {
            top: 0;
            bottom: 0;
            left: 0;
            right: 0;
            padding: calc(max(8px, env(safe-area-inset-top)) + 54px) 16px
              max(14px, env(safe-area-inset-bottom)) 16px;
          }

          .race-map-hud,
          .race-custom-panel,
          .race-auto-loop-panel {
            top: calc(max(8px, env(safe-area-inset-top)) + 52px);
            bottom: 10px;
            left: 10px;
            right: auto;
            width: min(390px, 42vw);
            border-radius: 22px;
            padding: 12px;
          }

          .race-map-hud-open,
          .race-custom-panel,
          .race-auto-loop-panel {
            max-height: none;
          }

          .race-auto-loop-panel-collapsed {
            max-height: 104px;
          }

          .race-map-hud-collapsed {
            height: auto;
            max-height: 176px;
          }

          .race-runner-list {
            max-height: calc(100dvh - 300px);
          }
        }

        @media (min-width: 768px) {
          .race-top-tabs {
            left: 16px;
            right: auto;
            width: 390px;
          }

          .custom-guide-toast {
            left: 424px;
            right: 16px;
            top: 16px;
          }

          .map-location-control {
            top: 16px;
            right: 16px;
            max-width: 360px;
          }

          .race-setup-panel {
            top: 0;
            bottom: 0;
            left: 0;
            right: 0;
            padding: 84px 24px 24px 24px;
          }

          .race-map-hud,
          .race-custom-panel,
          .race-auto-loop-panel {
            top: 72px;
            bottom: auto;
            left: 16px;
            right: auto;
            width: 390px;
            border-radius: 24px;
            padding: 14px;
          }

          .race-map-hud-open,
          .race-custom-panel,
          .race-auto-loop-panel {
            max-height: calc(100dvh - 88px);
          }

          .race-auto-loop-panel-collapsed {
            max-height: 110px;
          }

          .race-map-hud-collapsed {
            max-height: 176px;
          }

          .race-runner-list {
            max-height: min(330px, calc(100dvh - 365px));
          }

          .run-settings-backdrop {
            align-items: center;
            padding: 24px;
          }

          .run-settings-panel {
            width: 430px;
            max-height: calc(100dvh - 48px);
            border-radius: 24px;
          }
        }

        @media (max-width: 390px) {
          .race-setup-panel {
            padding-left: 10px;
            padding-right: 10px;
          }

          .race-map-hud,
          .race-custom-panel,
          .race-auto-loop-panel {
            left: 8px;
            right: 8px;
            padding: 10px;
          }

          .race-tab-button {
            padding: 9px 10px;
            font-size: 13px;
          }

          .custom-guide-toast {
            left: 8px;
            right: 8px;
          }
        }

        /* =========================================================
           Setup background isolation + SVG-enhanced liquid glass
           - Hide Mapbox canvas behind setup tab
           - Keep map tab untouched
           - Use SVG filters only on decorative layers, not on text
           ========================================================= */
        .liquid-filter-svg {
          position: absolute;
          width: 0;
          height: 0;
          overflow: hidden;
          pointer-events: none;
        }

        .race-root-setup .race-map {
          opacity: 0 !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }

        .race-root-map .race-map {
          opacity: 1 !important;
          visibility: visible !important;
          pointer-events: auto;
        }

        .race-root-setup .setup-background {
          position: absolute;
          inset: 0;
          z-index: 20;
          overflow: hidden;
          background:
            radial-gradient(
              circle at 17% 8%,
              rgba(255, 255, 255, 0.96),
              transparent 34%
            ),
            radial-gradient(
              circle at 78% 14%,
              rgba(219, 234, 254, 0.58),
              transparent 29%
            ),
            radial-gradient(
              circle at 16% 88%,
              rgba(220, 252, 231, 0.42),
              transparent 31%
            ),
            radial-gradient(
              circle at 84% 82%,
              rgba(254, 226, 226, 0.26),
              transparent 32%
            ),
            linear-gradient(
              135deg,
              #f8fafc 0%,
              #eef2f7 47%,
              #fbfdff 100%
            ) !important;
          background-image: none !important;
          background-size: auto !important;
          background-position: center !important;
          background-repeat: no-repeat !important;
        }

        .race-root-setup .setup-background::before {
          content: "";
          position: absolute;
          inset: -16%;
          z-index: 0;
          background:
            linear-gradient(
              118deg,
              transparent 0 18%,
              rgba(255, 255, 255, 0.62) 18.6% 19.4%,
              transparent 20% 100%
            ),
            linear-gradient(
              27deg,
              transparent 0 57%,
              rgba(255, 255, 255, 0.38) 58% 59.2%,
              transparent 60% 100%
            ),
            radial-gradient(
              circle at 42% 28%,
              rgba(255, 255, 255, 0.44),
              transparent 30%
            );
          filter: url("#liquid-background-warp") blur(0.25px);
          opacity: 0.80;
          pointer-events: none;
        }

        .race-root-setup .setup-background::after {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 0;
          background:
            radial-gradient(
              circle at 50% -8%,
              rgba(255, 255, 255, 0.84),
              transparent 39%
            ),
            linear-gradient(
              to bottom,
              rgba(255, 255, 255, 0.08),
              rgba(255, 255, 255, 0.34)
            );
          pointer-events: none;
        }

        .hero-glass-card::before,
        .race-tab-button::before,
        .course-action-button::before,
        .course-action-primary::before,
        .target-distance-popover::before,
        .run-settings-panel::before,
        .race-map-hud::before,
        .race-custom-panel::before,
        .race-auto-loop-panel::before,
        .race-setup-panel .rounded-xl.border::before,
        .race-setup-panel .rounded-lg.border::before,
        .race-setup-panel .rounded-xl[class*="border"]::before,
        .race-setup-panel .rounded-lg[class*="border"]::before {
          filter: url("#liquid-glass-soft");
        }

        @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
          .hero-glass-card,
          .race-tab-button,
          .course-action-button,
          .course-action-primary,
          .run-settings-panel,
          .race-map-hud,
          .race-custom-panel,
          .race-auto-loop-panel,
          .race-setup-panel .rounded-xl.border,
          .race-setup-panel .rounded-lg.border {
            background: rgba(255, 255, 255, 0.82) !important;
          }
        }


        /* =========================================================
           Transparent Liquid Glass refinement
           - Keep hero as-is
           - Non-hero cards: near-clear liquid glass
           - Selected controls: black glass
           - Unselected controls: transparent glass
           - Disabled controls: same transparent glass, gray text only
           ========================================================= */
        .race-root-setup .race-setup-panel > div {
          position: relative;
          z-index: 2;
        }

        .race-root-setup .race-setup-panel .rounded-xl.border:not(.hero-glass-card),
        .race-root-setup .race-setup-panel .rounded-lg.border:not(.hero-glass-card),
        .race-root-setup .race-setup-panel .rounded-xl[class*="border"]:not(.hero-glass-card),
        .race-root-setup .race-setup-panel .rounded-lg[class*="border"]:not(.hero-glass-card) {
          position: relative;
          overflow: hidden;
          border-color: rgba(15, 23, 42, 0.13) !important;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.13),
              rgba(255, 255, 255, 0.035)
            ) !important;
          backdrop-filter: blur(30px) saturate(180%);
          -webkit-backdrop-filter: blur(30px) saturate(180%);
          box-shadow:
            0 18px 46px rgba(15, 23, 42, 0.07),
            inset 0 1px 0 rgba(255, 255, 255, 0.60),
            inset 0 -1px 0 rgba(255, 255, 255, 0.10);
        }

        .race-root-setup .race-setup-panel .rounded-xl.border:not(.hero-glass-card)::before,
        .race-root-setup .race-setup-panel .rounded-lg.border:not(.hero-glass-card)::before,
        .race-root-setup .race-setup-panel .rounded-xl[class*="border"]:not(.hero-glass-card)::before,
        .race-root-setup .race-setup-panel .rounded-lg[class*="border"]:not(.hero-glass-card)::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 0;
          border-radius: inherit;
          background:
            radial-gradient(
              circle at 18% 0%,
              rgba(255, 255, 255, 0.34),
              transparent 34%
            ),
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.22),
              transparent 48%
            );
          pointer-events: none;
          filter: url("#liquid-glass-soft");
          opacity: 0.82;
        }

        .race-root-setup .race-setup-panel .rounded-xl.border:not(.hero-glass-card) > *,
        .race-root-setup .race-setup-panel .rounded-lg.border:not(.hero-glass-card) > *,
        .race-root-setup .race-setup-panel .rounded-xl[class*="border"]:not(.hero-glass-card) > *,
        .race-root-setup .race-setup-panel .rounded-lg[class*="border"]:not(.hero-glass-card) > * {
          position: relative;
          z-index: 1;
        }

        /* Inner informational surfaces should be almost fully transparent. */
        .race-root-setup .race-setup-panel .bg-white,
        .race-root-setup .race-setup-panel .bg-slate-50,
        .race-root-setup .race-setup-panel .bg-blue-50,
        .race-root-setup .race-setup-panel .bg-orange-50,
        .race-root-setup .race-setup-panel .bg-red-50,
        .race-root-setup .race-setup-panel .bg-yellow-50,
        .race-root-setup .race-setup-panel .bg-emerald-50,
        .race-root-setup .race-setup-panel .bg-purple-50,
        .race-root-setup .run-settings-panel .bg-white,
        .race-root-setup .run-settings-panel .bg-slate-50,
        .race-root-setup .run-settings-panel .bg-blue-50,
        .race-root-setup .run-settings-panel .bg-orange-50,
        .race-root-setup .run-settings-panel .bg-green-50 {
          border-color: rgba(15, 23, 42, 0.10) !important;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.10),
              rgba(255, 255, 255, 0.025)
            ) !important;
          backdrop-filter: blur(24px) saturate(170%);
          -webkit-backdrop-filter: blur(24px) saturate(170%);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.40),
            0 8px 20px rgba(15, 23, 42, 0.035);
        }

        /* Inputs: clear liquid field with strong focus ring. */
        .race-root-setup .race-setup-panel input,
        .race-root-setup .run-settings-panel input {
          border-color: rgba(15, 23, 42, 0.14) !important;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.14),
              rgba(255, 255, 255, 0.035)
            ) !important;
          color: #0f172a !important;
          backdrop-filter: blur(24px) saturate(170%);
          -webkit-backdrop-filter: blur(24px) saturate(170%);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.48),
            0 8px 22px rgba(15, 23, 42, 0.05);
        }

        .race-root-setup .race-setup-panel input:focus,
        .race-root-setup .run-settings-panel input:focus {
          border-color: rgba(15, 23, 42, 0.32) !important;
          box-shadow:
            0 0 0 3px rgba(15, 23, 42, 0.08),
            inset 0 1px 0 rgba(255, 255, 255, 0.56),
            0 10px 24px rgba(15, 23, 42, 0.08);
        }

        .race-root-setup .race-setup-panel input::placeholder,
        .race-root-setup .run-settings-panel input::placeholder {
          color: rgba(71, 85, 105, 0.55);
        }

        /* Default unselected buttons: transparent liquid glass. */
        .race-root-setup .race-setup-panel button:not(.race-tab-button):not(.hero-glass-card),
        .race-root-setup .run-settings-panel button,
        .race-root-setup .course-action-button,
        .race-root-setup .course-action-primary {
          position: relative;
          overflow: hidden;
          border: 1px solid rgba(15, 23, 42, 0.14) !important;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.13),
              rgba(255, 255, 255, 0.025)
            ) !important;
          color: #0f172a !important;
          backdrop-filter: blur(26px) saturate(180%);
          -webkit-backdrop-filter: blur(26px) saturate(180%);
          box-shadow:
            0 10px 26px rgba(15, 23, 42, 0.055),
            inset 0 1px 0 rgba(255, 255, 255, 0.52),
            inset 0 -1px 0 rgba(255, 255, 255, 0.12) !important;
          transition:
            transform 140ms ease,
            filter 140ms ease,
            border-color 140ms ease,
            box-shadow 140ms ease,
            background 140ms ease;
        }

        .race-root-setup .race-setup-panel button:not(.race-tab-button):not(.hero-glass-card)::before,
        .race-root-setup .run-settings-panel button::before,
        .race-root-setup .course-action-button::before,
        .race-root-setup .course-action-primary::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 0;
          border-radius: inherit;
          background:
            radial-gradient(
              circle at 22% 0%,
              rgba(255, 255, 255, 0.42),
              transparent 36%
            ),
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.26),
              transparent 48%
            );
          pointer-events: none;
          filter: url("#liquid-glass-soft");
          opacity: 0.86;
        }

        .race-root-setup .race-setup-panel button:not(.race-tab-button):not(.hero-glass-card) > *,
        .race-root-setup .run-settings-panel button > *,
        .race-root-setup .course-action-button > *,
        .race-root-setup .course-action-primary > * {
          position: relative;
          z-index: 1;
        }

        .race-root-setup .race-setup-panel button:not(:disabled):hover,
        .race-root-setup .run-settings-panel button:not(:disabled):hover,
        .race-root-setup .course-action-button:not(:disabled):hover,
        .race-root-setup .course-action-primary:not(:disabled):hover {
          border-color: rgba(15, 23, 42, 0.24) !important;
          filter: brightness(1.015);
          box-shadow:
            0 14px 34px rgba(15, 23, 42, 0.085),
            inset 0 1px 0 rgba(255, 255, 255, 0.60) !important;
        }

        /* Selected controls: black liquid glass. */
        .race-root-setup .race-tab-active,
        .race-root-setup .race-setup-panel button.bg-slate-900,
        .race-root-setup .race-setup-panel button.bg-slate-950,
        .race-root-setup .race-setup-panel button.bg-slate-800,
        .race-root-setup .race-setup-panel button.bg-blue-600,
        .race-root-setup .race-setup-panel button.bg-green-600,
        .race-root-setup .race-setup-panel button.bg-orange-600,
        .race-root-setup .run-settings-panel button.bg-slate-900,
        .race-root-setup .run-settings-panel button.bg-slate-950,
        .race-root-setup .run-settings-panel button.bg-slate-800,
        .race-root-setup .run-settings-panel button.bg-blue-600,
        .race-root-setup .run-settings-panel button.bg-green-600,
        .race-root-setup .run-settings-panel button.bg-orange-600 {
          border-color: rgba(255, 255, 255, 0.22) !important;
          background:
            linear-gradient(
              135deg,
              rgba(15, 23, 42, 0.82),
              rgba(15, 23, 42, 0.52)
            ) !important;
          color: rgba(255, 255, 255, 0.96) !important;
          backdrop-filter: blur(28px) saturate(180%);
          -webkit-backdrop-filter: blur(28px) saturate(180%);
          box-shadow:
            0 16px 36px rgba(15, 23, 42, 0.20),
            inset 0 1px 0 rgba(255, 255, 255, 0.20),
            inset 0 -1px 0 rgba(255, 255, 255, 0.08) !important;
        }

        .race-root-setup .race-tab-active::before,
        .race-root-setup .race-setup-panel button.bg-slate-900::before,
        .race-root-setup .race-setup-panel button.bg-slate-950::before,
        .race-root-setup .race-setup-panel button.bg-slate-800::before,
        .race-root-setup .race-setup-panel button.bg-blue-600::before,
        .race-root-setup .race-setup-panel button.bg-green-600::before,
        .race-root-setup .race-setup-panel button.bg-orange-600::before,
        .race-root-setup .run-settings-panel button.bg-slate-900::before,
        .race-root-setup .run-settings-panel button.bg-slate-950::before,
        .race-root-setup .run-settings-panel button.bg-slate-800::before,
        .race-root-setup .run-settings-panel button.bg-blue-600::before,
        .race-root-setup .run-settings-panel button.bg-green-600::before,
        .race-root-setup .run-settings-panel button.bg-orange-600::before {
          background:
            radial-gradient(
              circle at 24% 0%,
              rgba(255, 255, 255, 0.28),
              transparent 40%
            ),
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.18),
              transparent 48%
            );
          opacity: 0.92;
        }

        .race-root-setup .race-tab-active,
        .race-root-setup .race-tab-active * ,
        .race-root-setup .race-setup-panel button.bg-slate-900,
        .race-root-setup .race-setup-panel button.bg-slate-900 *,
        .race-root-setup .race-setup-panel button.bg-slate-950,
        .race-root-setup .race-setup-panel button.bg-slate-950 *,
        .race-root-setup .race-setup-panel button.bg-slate-800,
        .race-root-setup .race-setup-panel button.bg-slate-800 *,
        .race-root-setup .race-setup-panel button.bg-blue-600,
        .race-root-setup .race-setup-panel button.bg-blue-600 *,
        .race-root-setup .race-setup-panel button.bg-green-600,
        .race-root-setup .race-setup-panel button.bg-green-600 *,
        .race-root-setup .race-setup-panel button.bg-orange-600,
        .race-root-setup .race-setup-panel button.bg-orange-600 *,
        .race-root-setup .run-settings-panel button.bg-slate-900,
        .race-root-setup .run-settings-panel button.bg-slate-900 *,
        .race-root-setup .run-settings-panel button.bg-slate-950,
        .race-root-setup .run-settings-panel button.bg-slate-950 *,
        .race-root-setup .run-settings-panel button.bg-slate-800,
        .race-root-setup .run-settings-panel button.bg-slate-800 *,
        .race-root-setup .run-settings-panel button.bg-blue-600,
        .race-root-setup .run-settings-panel button.bg-blue-600 *,
        .race-root-setup .run-settings-panel button.bg-green-600,
        .race-root-setup .run-settings-panel button.bg-green-600 *,
        .race-root-setup .run-settings-panel button.bg-orange-600,
        .race-root-setup .run-settings-panel button.bg-orange-600 * {
          color: rgba(255, 255, 255, 0.96) !important;
        }

        /* Disabled controls: keep glass surface, gray text only. */
        .race-root-setup .race-setup-panel button:disabled,
        .race-root-setup .run-settings-panel button:disabled,
        .race-root-setup .course-action-button:disabled,
        .race-root-setup .course-action-primary:disabled {
          opacity: 1 !important;
          cursor: not-allowed;
          border-color: rgba(15, 23, 42, 0.08) !important;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.10),
              rgba(255, 255, 255, 0.025)
            ) !important;
          color: rgba(100, 116, 139, 0.58) !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.32),
            0 8px 18px rgba(15, 23, 42, 0.025) !important;
          filter: none !important;
        }

        .race-root-setup .race-setup-panel button:disabled *,
        .race-root-setup .run-settings-panel button:disabled *,
        .race-root-setup .course-action-button:disabled *,
        .race-root-setup .course-action-primary:disabled * {
          color: rgba(100, 116, 139, 0.58) !important;
        }

        .race-root-setup .race-setup-panel button:active:not(:disabled),
        .race-root-setup .run-settings-panel button:active:not(:disabled),
        .race-root-setup .course-action-button:active:not(:disabled),
        .race-root-setup .course-action-primary:active:not(:disabled) {
          transform: translateY(1px) scale(0.972);
          filter: brightness(0.94);
          box-shadow:
            0 7px 18px rgba(15, 23, 42, 0.14),
            inset 0 3px 10px rgba(15, 23, 42, 0.15),
            inset 0 1px 0 rgba(255, 255, 255, 0.16) !important;
        }

        /* Make small secondary color labels obey transparent liquid palette. */
        .race-root-setup .race-setup-panel .text-blue-700,
        .race-root-setup .race-setup-panel .text-orange-700,
        .race-root-setup .race-setup-panel .text-green-700,
        .race-root-setup .race-setup-panel .text-red-700,
        .race-root-setup .race-setup-panel .text-purple-700,
        .race-root-setup .race-setup-panel .text-yellow-800 {
          color: rgba(30, 41, 59, 0.84) !important;
        }

        /* Keep target validation bubble tactile and readable. */
        .race-root-setup .target-distance-popover {
          border-color: rgba(15, 23, 42, 0.18) !important;
          background:
            linear-gradient(
              135deg,
              rgba(15, 23, 42, 0.80),
              rgba(15, 23, 42, 0.54)
            ) !important;
          color: rgba(255, 255, 255, 0.96) !important;
        }



        /* =========================================================
           FINAL: iOS-like bright liquid glass system override
           Goal: translucent optical glass, white interface, black selected glass
           ========================================================= */
        .race-root-setup .race-map {
          opacity: 0 !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }

        .race-root-map .race-map {
          opacity: 1 !important;
          visibility: visible !important;
          pointer-events: auto !important;
        }

        .race-root-setup .setup-background {
          position: absolute;
          inset: 0;
          z-index: 20;
          overflow: hidden;
          background:
            radial-gradient(circle at 24% 13%, rgba(255, 255, 255, 0.96), transparent 25%),
            radial-gradient(circle at 76% 8%, rgba(226, 241, 255, 0.72), transparent 26%),
            radial-gradient(circle at 14% 85%, rgba(230, 255, 245, 0.62), transparent 31%),
            radial-gradient(circle at 78% 82%, rgba(246, 248, 255, 0.90), transparent 32%),
            linear-gradient(135deg, #f7f8fa 0%, #edf2f7 42%, #fbfcff 100%) !important;
          background-image: none !important;
        }

        .race-root-setup .setup-background::before {
          content: "";
          position: absolute;
          inset: -12%;
          z-index: 0;
          pointer-events: none;
          background:
            linear-gradient(90deg, transparent 0 18%, rgba(15, 23, 42, 0.075) 18.2% 18.35%, transparent 18.7% 100%),
            linear-gradient(0deg, transparent 0 71%, rgba(15, 23, 42, 0.052) 71.1% 71.25%, transparent 71.6% 100%),
            radial-gradient(ellipse at 28% 22%, rgba(255,255,255,0.78), transparent 24%),
            radial-gradient(ellipse at 72% 14%, rgba(255,255,255,0.52), transparent 19%),
            radial-gradient(ellipse at 70% 62%, rgba(255,255,255,0.62), transparent 22%);
          filter: url("#liquid-background-warp") blur(0.35px);
          opacity: 0.95;
        }

        .race-root-setup .setup-background::after {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 0;
          pointer-events: none;
          background:
            radial-gradient(circle at 48% 18%, rgba(255, 255, 255, 0.62), transparent 30%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.52), rgba(255, 255, 255, 0.06) 42%, rgba(255, 255, 255, 0.42));
        }

        .race-root-setup .race-setup-panel > div {
          position: relative;
          z-index: 2;
        }

        /* Typography tuned for bright glass */
        .race-root-setup .race-setup-panel,
        .race-root-setup .race-setup-panel * {
          text-shadow: none;
        }

        .race-root-setup .race-setup-panel .text-slate-950,
        .race-root-setup .race-setup-panel .text-slate-900,
        .race-root-setup .race-setup-panel .text-slate-800,
        .race-root-setup .race-setup-panel .text-slate-700 {
          color: rgba(15, 23, 42, 0.92) !important;
        }

        .race-root-setup .race-setup-panel .text-slate-600,
        .race-root-setup .race-setup-panel .text-slate-500,
        .race-root-setup .race-setup-panel .text-slate-400 {
          color: rgba(51, 65, 85, 0.68) !important;
        }

        /* Optical slab: used by every setup card including hero. */
        .race-root-setup .hero-glass-card,
        .race-root-setup .race-setup-panel .rounded-xl.border,
        .race-root-setup .race-setup-panel .rounded-lg.border,
        .race-root-setup .race-setup-panel .rounded-xl[class*="border"],
        .race-root-setup .race-setup-panel .rounded-lg[class*="border"],
        .race-root-setup .run-settings-panel {
          position: relative;
          overflow: hidden;
          isolation: isolate;
          border: 1px solid rgba(255, 255, 255, 0.74) !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0.075)) !important;
          backdrop-filter: blur(34px) saturate(190%) brightness(1.05);
          -webkit-backdrop-filter: blur(34px) saturate(190%) brightness(1.05);
          box-shadow:
            0 24px 70px rgba(15, 23, 42, 0.095),
            0 4px 16px rgba(15, 23, 42, 0.045),
            inset 0 1.4px 0 rgba(255, 255, 255, 0.95),
            inset 1px 0 0 rgba(255, 255, 255, 0.42),
            inset -1px 0 0 rgba(255, 255, 255, 0.22),
            inset 0 -1.2px 0 rgba(15, 23, 42, 0.075) !important;
        }

        .race-root-setup .hero-glass-card {
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.52), rgba(255, 255, 255, 0.16)) !important;
          border-color: rgba(255, 255, 255, 0.88) !important;
          color: rgba(15, 23, 42, 0.92) !important;
          box-shadow:
            0 28px 78px rgba(15, 23, 42, 0.10),
            0 8px 24px rgba(15, 23, 42, 0.055),
            inset 0 1.5px 0 rgba(255, 255, 255, 0.98),
            inset 0 -1.2px 0 rgba(15, 23, 42, 0.065) !important;
        }

        .race-root-setup .hero-glass-card .text-white,
        .race-root-setup .hero-glass-card .text-slate-50,
        .race-root-setup .hero-glass-card .text-slate-100 {
          color: rgba(15, 23, 42, 0.93) !important;
        }

        .race-root-setup .hero-glass-card [class*="tracking-"] {
          color: rgba(71, 85, 105, 0.82) !important;
        }

        .race-root-setup .hero-glass-card h1,
        .race-root-setup .hero-glass-card .text-3xl,
        .race-root-setup .hero-glass-card .text-4xl,
        .race-root-setup .hero-glass-card .font-black {
          color: #12a36f !important;
        }

        .race-root-setup .hero-glass-card::before,
        .race-root-setup .race-setup-panel .rounded-xl.border::before,
        .race-root-setup .race-setup-panel .rounded-lg.border::before,
        .race-root-setup .race-setup-panel .rounded-xl[class*="border"]::before,
        .race-root-setup .race-setup-panel .rounded-lg[class*="border"]::before,
        .race-root-setup .run-settings-panel::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: -1;
          border-radius: inherit;
          pointer-events: none;
          background:
            radial-gradient(circle at 18% 0%, rgba(255, 255, 255, 0.72), transparent 34%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.48), rgba(255, 255, 255, 0.06) 44%, transparent 100%);
          opacity: 0.92;
          filter: url("#liquid-glass-soft");
        }

        .race-root-setup .hero-glass-card::after,
        .race-root-setup .race-setup-panel .rounded-xl.border::after,
        .race-root-setup .race-setup-panel .rounded-lg.border::after,
        .race-root-setup .race-setup-panel .rounded-xl[class*="border"]::after,
        .race-root-setup .race-setup-panel .rounded-lg[class*="border"]::after,
        .race-root-setup .run-settings-panel::after {
          content: "";
          position: absolute;
          inset: 1px;
          z-index: -1;
          border-radius: inherit;
          pointer-events: none;
          background:
            linear-gradient(135deg, rgba(255,255,255,0.32), transparent 35%, rgba(255,255,255,0.08) 68%, transparent 100%);
          opacity: 0.78;
        }

        .race-root-setup .hero-glass-card > *,
        .race-root-setup .race-setup-panel .rounded-xl.border > *,
        .race-root-setup .race-setup-panel .rounded-lg.border > *,
        .race-root-setup .race-setup-panel .rounded-xl[class*="border"] > *,
        .race-root-setup .race-setup-panel .rounded-lg[class*="border"] > *,
        .race-root-setup .run-settings-panel > * {
          position: relative;
          z-index: 1;
        }

        /* Inner surfaces: thinner, almost lens-like glass rather than filled panels. */
        .race-root-setup .race-setup-panel .bg-white,
        .race-root-setup .race-setup-panel .bg-slate-50,
        .race-root-setup .race-setup-panel .bg-blue-50,
        .race-root-setup .race-setup-panel .bg-orange-50,
        .race-root-setup .race-setup-panel .bg-red-50,
        .race-root-setup .race-setup-panel .bg-yellow-50,
        .race-root-setup .race-setup-panel .bg-emerald-50 {
          border: 1px solid rgba(255, 255, 255, 0.58) !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.20), rgba(255, 255, 255, 0.035)) !important;
          backdrop-filter: blur(26px) saturate(180%) brightness(1.04);
          -webkit-backdrop-filter: blur(26px) saturate(180%) brightness(1.04);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.78),
            inset 0 -1px 0 rgba(15, 23, 42, 0.050),
            0 8px 20px rgba(15, 23, 42, 0.035) !important;
        }

        /* Inputs */
        .race-root-setup .race-setup-panel input,
        .race-root-setup .run-settings-panel input {
          border: 1px solid rgba(255, 255, 255, 0.68) !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.26), rgba(255, 255, 255, 0.055)) !important;
          color: rgba(15, 23, 42, 0.94) !important;
          backdrop-filter: blur(28px) saturate(185%) brightness(1.05);
          -webkit-backdrop-filter: blur(28px) saturate(185%) brightness(1.05);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.84),
            inset 0 -1px 0 rgba(15, 23, 42, 0.055),
            0 10px 24px rgba(15, 23, 42, 0.035) !important;
        }

        .race-root-setup .race-setup-panel input:focus,
        .race-root-setup .run-settings-panel input:focus {
          border-color: rgba(37, 99, 235, 0.38) !important;
          box-shadow:
            0 0 0 4px rgba(59, 130, 246, 0.12),
            inset 0 1px 0 rgba(255, 255, 255, 0.88),
            0 12px 28px rgba(15, 23, 42, 0.055) !important;
        }

        .race-root-setup .race-setup-panel input::placeholder,
        .race-root-setup .run-settings-panel input::placeholder {
          color: rgba(100, 116, 139, 0.62) !important;
        }

        /* Buttons: iOS-like transparent lens by default. */
        .race-root-setup .race-tab-button,
        .race-root-setup .race-setup-panel button:not(.hero-glass-card),
        .race-root-setup .run-settings-panel button,
        .race-root-setup .course-action-button,
        .race-root-setup .course-action-primary {
          position: relative;
          overflow: hidden;
          isolation: isolate;
          border: 1px solid rgba(255, 255, 255, 0.68) !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.040)) !important;
          color: rgba(15, 23, 42, 0.94) !important;
          backdrop-filter: blur(30px) saturate(190%) brightness(1.05);
          -webkit-backdrop-filter: blur(30px) saturate(190%) brightness(1.05);
          box-shadow:
            0 14px 34px rgba(15, 23, 42, 0.065),
            inset 0 1.25px 0 rgba(255, 255, 255, 0.90),
            inset 0 -1px 0 rgba(15, 23, 42, 0.055) !important;
          transition:
            transform 140ms ease,
            filter 140ms ease,
            box-shadow 140ms ease,
            border-color 140ms ease,
            background 140ms ease;
        }

        .race-root-setup .race-tab-button::before,
        .race-root-setup .race-setup-panel button:not(.hero-glass-card)::before,
        .race-root-setup .run-settings-panel button::before,
        .race-root-setup .course-action-button::before,
        .race-root-setup .course-action-primary::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: -1;
          border-radius: inherit;
          pointer-events: none;
          background:
            radial-gradient(circle at 24% 0%, rgba(255, 255, 255, 0.66), transparent 35%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.42), transparent 46%);
          filter: url("#liquid-glass-soft");
          opacity: 0.88;
        }

        .race-root-setup .race-tab-button > *,
        .race-root-setup .race-setup-panel button:not(.hero-glass-card) > *,
        .race-root-setup .run-settings-panel button > *,
        .race-root-setup .course-action-button > *,
        .race-root-setup .course-action-primary > * {
          position: relative;
          z-index: 1;
        }

        /* Selected state: black liquid glass, like the active pill in the reference. */
        .race-root-setup .race-tab-active,
        .race-root-setup .race-setup-panel button.bg-slate-900,
        .race-root-setup .race-setup-panel button.bg-slate-950,
        .race-root-setup .race-setup-panel button.bg-slate-800,
        .race-root-setup .race-setup-panel button.bg-blue-600,
        .race-root-setup .race-setup-panel button.bg-green-600,
        .race-root-setup .race-setup-panel button.bg-orange-600,
        .race-root-setup .run-settings-panel button.bg-slate-900,
        .race-root-setup .run-settings-panel button.bg-slate-950,
        .race-root-setup .run-settings-panel button.bg-slate-800,
        .race-root-setup .run-settings-panel button.bg-blue-600,
        .race-root-setup .run-settings-panel button.bg-green-600,
        .race-root-setup .run-settings-panel button.bg-orange-600 {
          border-color: rgba(255, 255, 255, 0.48) !important;
          background:
            linear-gradient(135deg, rgba(19, 24, 34, 0.76), rgba(12, 16, 24, 0.46)) !important;
          color: rgba(255, 255, 255, 0.97) !important;
          backdrop-filter: blur(32px) saturate(190%) brightness(1.03);
          -webkit-backdrop-filter: blur(32px) saturate(190%) brightness(1.03);
          box-shadow:
            0 18px 38px rgba(15, 23, 42, 0.19),
            inset 0 1px 0 rgba(255, 255, 255, 0.24),
            inset 0 -1px 0 rgba(255, 255, 255, 0.08) !important;
        }

        .race-root-setup .race-tab-active *,
        .race-root-setup .race-setup-panel button.bg-slate-900 *,
        .race-root-setup .race-setup-panel button.bg-slate-950 *,
        .race-root-setup .race-setup-panel button.bg-slate-800 *,
        .race-root-setup .race-setup-panel button.bg-blue-600 *,
        .race-root-setup .race-setup-panel button.bg-green-600 *,
        .race-root-setup .race-setup-panel button.bg-orange-600 *,
        .race-root-setup .run-settings-panel button.bg-slate-900 *,
        .race-root-setup .run-settings-panel button.bg-slate-950 *,
        .race-root-setup .run-settings-panel button.bg-slate-800 *,
        .race-root-setup .run-settings-panel button.bg-blue-600 *,
        .race-root-setup .run-settings-panel button.bg-green-600 *,
        .race-root-setup .run-settings-panel button.bg-orange-600 * {
          color: rgba(255, 255, 255, 0.97) !important;
        }

        /* Disabled: lens remains, text fades only. */
        .race-root-setup button:disabled,
        .race-root-setup .course-action-button:disabled,
        .race-root-setup .course-action-primary:disabled {
          opacity: 1 !important;
          cursor: not-allowed;
          border-color: rgba(255, 255, 255, 0.52) !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.028)) !important;
          color: rgba(100, 116, 139, 0.52) !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.58),
            inset 0 -1px 0 rgba(15, 23, 42, 0.035),
            0 8px 20px rgba(15, 23, 42, 0.025) !important;
          filter: none !important;
        }

        .race-root-setup button:disabled * {
          color: rgba(100, 116, 139, 0.52) !important;
        }

        .race-root-setup button:not(:disabled):hover,
        .race-root-setup .course-action-button:not(:disabled):hover,
        .race-root-setup .course-action-primary:not(:disabled):hover {
          border-color: rgba(255, 255, 255, 0.86) !important;
          filter: brightness(1.012);
          box-shadow:
            0 18px 42px rgba(15, 23, 42, 0.085),
            inset 0 1.25px 0 rgba(255, 255, 255, 0.96),
            inset 0 -1px 0 rgba(15, 23, 42, 0.055) !important;
        }

        .race-root-setup button:active:not(:disabled),
        .race-root-setup .course-action-button:active:not(:disabled),
        .race-root-setup .course-action-primary:active:not(:disabled) {
          transform: translateY(1px) scale(0.972);
          filter: brightness(0.965);
          box-shadow:
            0 7px 18px rgba(15, 23, 42, 0.10),
            inset 0 4px 14px rgba(15, 23, 42, 0.14),
            inset 0 1px 0 rgba(255, 255, 255, 0.24) !important;
        }

        /* Popover stays readable. */
        .race-root-setup .target-distance-popover {
          border-color: rgba(255, 255, 255, 0.54) !important;
          background:
            linear-gradient(135deg, rgba(19, 24, 34, 0.82), rgba(12, 16, 24, 0.54)) !important;
          color: rgba(255, 255, 255, 0.97) !important;
          backdrop-filter: blur(30px) saturate(180%);
          -webkit-backdrop-filter: blur(30px) saturate(180%);
          box-shadow:
            0 18px 42px rgba(15, 23, 42, 0.18),
            inset 0 1px 0 rgba(255,255,255,0.20) !important;
        }



        /* =========================================================
           WebGL shader liquid-glass background pass
           - This is a real fragment-shader layer, not a static image.
           - DOM text remains separate for readability.
           ========================================================= */
        .race-root-setup .setup-background {
          position: absolute;
          inset: 0;
          z-index: 20;
          overflow: hidden;
          background:
            radial-gradient(circle at 18% 10%, rgba(255, 255, 255, 0.98), transparent 38%),
            radial-gradient(circle at 82% 18%, rgba(245, 247, 250, 0.72), transparent 36%),
            radial-gradient(circle at 18% 92%, rgba(235, 239, 245, 0.46), transparent 34%),
            linear-gradient(135deg, #fbfcfe 0%, #f3f5f8 48%, #ffffff 100%) !important;
          background-image: none !important;
        }

        .setup-liquid-shader-canvas {
          position: absolute;
          inset: 0;
          z-index: 21;
          width: 100%;
          height: 100%;
          pointer-events: none;
          opacity: 0.62;
          mix-blend-mode: normal;
          filter: saturate(0.15) contrast(1.02);
        }

        .race-root-map .setup-liquid-shader-canvas {
          display: none;
        }

        .race-root-setup .race-setup-panel,
        .race-root-setup .race-top-tabs {
          position: absolute;
          z-index: 40;
        }

        .race-root-setup .race-top-tabs {
          z-index: 55;
        }

        /* Shader-aware glass: lower fill so the WebGL liquid layer shows through. */
        .race-root-setup .hero-glass-card,
        .race-root-setup .race-setup-panel .rounded-xl.border,
        .race-root-setup .race-setup-panel .rounded-lg.border,
        .race-root-setup .race-setup-panel .rounded-xl[class*="border"],
        .race-root-setup .race-setup-panel .rounded-lg[class*="border"],
        .race-root-setup .run-settings-panel {
          position: relative;
          overflow: hidden;
          border-color: rgba(255, 255, 255, 0.66) !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.030)) !important;
          backdrop-filter: blur(34px) saturate(190%) brightness(1.05);
          -webkit-backdrop-filter: blur(34px) saturate(190%) brightness(1.05);
          box-shadow:
            0 24px 58px rgba(15, 23, 42, 0.10),
            inset 0 1.5px 0 rgba(255, 255, 255, 0.92),
            inset 0 -1px 0 rgba(15, 23, 42, 0.055) !important;
        }

        .race-root-setup .hero-glass-card::before,
        .race-root-setup .race-setup-panel .rounded-xl.border::before,
        .race-root-setup .race-setup-panel .rounded-lg.border::before,
        .race-root-setup .race-setup-panel .rounded-xl[class*="border"]::before,
        .race-root-setup .race-setup-panel .rounded-lg[class*="border"]::before,
        .race-root-setup .run-settings-panel::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 0;
          border-radius: inherit;
          pointer-events: none;
          background:
            radial-gradient(circle at 20% 0%, rgba(255,255,255,0.68), transparent 34%),
            linear-gradient(180deg, rgba(255,255,255,0.38), rgba(255,255,255,0.08) 42%, transparent 100%);
          opacity: 0.82;
          filter: url("#liquid-glass-soft");
        }

        .race-root-setup .hero-glass-card::after,
        .race-root-setup .race-setup-panel .rounded-xl.border::after,
        .race-root-setup .race-setup-panel .rounded-lg.border::after,
        .race-root-setup .race-setup-panel .rounded-xl[class*="border"]::after,
        .race-root-setup .race-setup-panel .rounded-lg[class*="border"]::after,
        .race-root-setup .run-settings-panel::after {
          content: "";
          position: absolute;
          inset: 1px;
          z-index: 0;
          border-radius: inherit;
          pointer-events: none;
          background:
            linear-gradient(135deg, rgba(255,255,255,0.38), transparent 34%, rgba(255,255,255,0.08) 68%, transparent 100%);
          opacity: 0.72;
        }

        .race-root-setup .hero-glass-card > *,
        .race-root-setup .race-setup-panel .rounded-xl.border > *,
        .race-root-setup .race-setup-panel .rounded-lg.border > *,
        .race-root-setup .race-setup-panel .rounded-xl[class*="border"] > *,
        .race-root-setup .race-setup-panel .rounded-lg[class*="border"] > *,
        .race-root-setup .run-settings-panel > * {
          position: relative;
          z-index: 1;
        }

        .race-root-setup .hero-glass-card .text-emerald-600,
        .race-root-setup .hero-glass-card h1,
        .race-root-setup .hero-glass-card [class*="text-3xl"] {
          color: #16a37b !important;
        }

        .race-root-setup .race-setup-panel .bg-white,
        .race-root-setup .race-setup-panel .bg-slate-50,
        .race-root-setup .race-setup-panel .bg-blue-50,
        .race-root-setup .race-setup-panel .bg-orange-50,
        .race-root-setup .race-setup-panel .bg-red-50,
        .race-root-setup .race-setup-panel .bg-yellow-50,
        .race-root-setup .race-setup-panel .bg-emerald-50,
        .race-root-setup .run-settings-panel .bg-white,
        .race-root-setup .run-settings-panel .bg-slate-50 {
          border: 1px solid rgba(255, 255, 255, 0.68) !important;
          background: linear-gradient(135deg, rgba(255,255,255,0.16), rgba(255,255,255,0.030)) !important;
          backdrop-filter: blur(30px) saturate(190%) brightness(1.05);
          -webkit-backdrop-filter: blur(30px) saturate(190%) brightness(1.05);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.86),
            inset 0 -1px 0 rgba(15,23,42,0.045),
            0 10px 24px rgba(15,23,42,0.035) !important;
        }

        .race-root-setup input,
        .race-root-setup textarea,
        .race-root-setup select {
          border: 1px solid rgba(255,255,255,0.72) !important;
          background: linear-gradient(135deg, rgba(255,255,255,0.20), rgba(255,255,255,0.040)) !important;
          color: rgba(15,23,42,0.94) !important;
          backdrop-filter: blur(28px) saturate(190%) brightness(1.05);
          -webkit-backdrop-filter: blur(28px) saturate(190%) brightness(1.05);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.88),
            inset 0 -1px 0 rgba(15,23,42,0.045),
            0 10px 22px rgba(15,23,42,0.035) !important;
        }

        .race-root-setup button,
        .race-root-setup .course-action-button,
        .race-root-setup .course-action-primary {
          position: relative;
          overflow: hidden;
          isolation: isolate;
          border: 1px solid rgba(255,255,255,0.72) !important;
          background: linear-gradient(135deg, rgba(255,255,255,0.20), rgba(255,255,255,0.030)) !important;
          color: rgba(15,23,42,0.94) !important;
          backdrop-filter: blur(30px) saturate(190%) brightness(1.05);
          -webkit-backdrop-filter: blur(30px) saturate(190%) brightness(1.05);
          box-shadow:
            0 14px 34px rgba(15,23,42,0.06),
            inset 0 1.25px 0 rgba(255,255,255,0.92),
            inset 0 -1px 0 rgba(15,23,42,0.05) !important;
          transition: transform 140ms ease, filter 140ms ease, box-shadow 140ms ease, border-color 140ms ease, background 140ms ease;
        }

        .race-root-setup button::before,
        .race-root-setup .course-action-button::before,
        .race-root-setup .course-action-primary::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: -1;
          border-radius: inherit;
          pointer-events: none;
          background:
            radial-gradient(circle at 24% 0%, rgba(255,255,255,0.70), transparent 35%),
            linear-gradient(180deg, rgba(255,255,255,0.36), transparent 48%);
          filter: url("#liquid-glass-soft");
          opacity: 0.78;
        }

        .race-root-setup .race-tab-active,
        .race-root-setup button.bg-slate-900,
        .race-root-setup button.bg-slate-950,
        .race-root-setup button.bg-slate-800,
        .race-root-setup button.bg-blue-600,
        .race-root-setup button.bg-green-600,
        .race-root-setup button.bg-orange-600 {
          border-color: rgba(255,255,255,0.50) !important;
          background: linear-gradient(135deg, rgba(20,24,34,0.78), rgba(10,14,22,0.50)) !important;
          color: rgba(255,255,255,0.98) !important;
          backdrop-filter: blur(34px) saturate(190%) brightness(1.02);
          -webkit-backdrop-filter: blur(34px) saturate(190%) brightness(1.02);
          box-shadow:
            0 18px 38px rgba(15,23,42,0.18),
            inset 0 1px 0 rgba(255,255,255,0.24),
            inset 0 -1px 0 rgba(255,255,255,0.08) !important;
        }

        .race-root-setup .race-tab-active *,
        .race-root-setup button.bg-slate-900 *,
        .race-root-setup button.bg-slate-950 *,
        .race-root-setup button.bg-slate-800 *,
        .race-root-setup button.bg-blue-600 *,
        .race-root-setup button.bg-green-600 *,
        .race-root-setup button.bg-orange-600 * {
          color: rgba(255,255,255,0.98) !important;
        }

        .race-root-setup button:disabled,
        .race-root-setup .course-action-button:disabled,
        .race-root-setup .course-action-primary:disabled {
          opacity: 1 !important;
          cursor: not-allowed;
          border-color: rgba(255,255,255,0.58) !important;
          background: linear-gradient(135deg, rgba(255,255,255,0.14), rgba(255,255,255,0.020)) !important;
          color: rgba(100,116,139,0.50) !important;
          filter: none !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.62),
            inset 0 -1px 0 rgba(15,23,42,0.035),
            0 8px 20px rgba(15,23,42,0.025) !important;
        }

        .race-root-setup button:disabled * {
          color: rgba(100,116,139,0.50) !important;
        }

        .race-root-setup button:active:not(:disabled),
        .race-root-setup .course-action-button:active:not(:disabled),
        .race-root-setup .course-action-primary:active:not(:disabled) {
          transform: translateY(1px) scale(0.972);
          filter: brightness(0.965);
          box-shadow:
            0 7px 18px rgba(15,23,42,0.10),
            inset 0 4px 14px rgba(15,23,42,0.14),
            inset 0 1px 0 rgba(255,255,255,0.24) !important;
        }


        /* =========================================================
           PWA pass: explicit selected/unselected liquid controls
           - Selected: black glass
           - Unselected: clear glass
           - Disabled: clear glass, gray text only
           ========================================================= */
        .race-root-setup .liquid-selected-control {
          border: 1px solid rgba(255, 255, 255, 0.42) !important;
          background:
            linear-gradient(
              135deg,
              rgba(8, 13, 23, 0.86),
              rgba(31, 41, 55, 0.58)
            ) !important;
          color: rgba(255, 255, 255, 0.98) !important;
          text-shadow: 0 1px 1px rgba(0, 0, 0, 0.32);
          backdrop-filter: blur(28px) saturate(180%) !important;
          -webkit-backdrop-filter: blur(28px) saturate(180%) !important;
          box-shadow:
            0 14px 32px rgba(15, 23, 42, 0.18),
            inset 0 1px 0 rgba(255, 255, 255, 0.38),
            inset 0 -1px 0 rgba(255, 255, 255, 0.10) !important;
        }

        .race-root-setup .liquid-clear-control {
          border: 1px solid rgba(148, 163, 184, 0.32) !important;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.18),
              rgba(255, 255, 255, 0.045)
            ) !important;
          color: rgba(15, 23, 42, 0.88) !important;
          backdrop-filter: blur(30px) saturate(175%) !important;
          -webkit-backdrop-filter: blur(30px) saturate(175%) !important;
          box-shadow:
            0 10px 24px rgba(15, 23, 42, 0.055),
            inset 0 1px 0 rgba(255, 255, 255, 0.74),
            inset 0 -1px 0 rgba(255, 255, 255, 0.10) !important;
        }

        .race-root-setup .distance-preset-button,
        .race-root-setup .liquid-choice-button {
          position: relative;
          overflow: hidden;
          isolation: isolate;
        }

        .race-root-setup .distance-preset-button::before,
        .race-root-setup .liquid-choice-button::before {
          content: "";
          position: absolute;
          inset: 1px;
          z-index: -1;
          border-radius: inherit;
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.55),
              transparent 48%
            );
          opacity: 0.58;
          pointer-events: none;
          filter: url("#liquid-glass-soft");
        }

        .race-root-setup .liquid-selected-control::before {
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.28),
              transparent 48%
            );
          opacity: 0.70;
        }

        .race-root-setup .liquid-clear-control:disabled,
        .race-root-setup button.liquid-clear-control:disabled,
        .race-root-setup .liquid-selected-control:disabled,
        .race-root-setup button.liquid-selected-control:disabled {
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.12),
              rgba(255, 255, 255, 0.035)
            ) !important;
          border-color: rgba(148, 163, 184, 0.24) !important;
          color: rgba(100, 116, 139, 0.56) !important;
          text-shadow: none !important;
          opacity: 1 !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.48),
            0 8px 18px rgba(15, 23, 42, 0.035) !important;
        }

        .race-root-setup .liquid-selected-control:active:not(:disabled),
        .race-root-setup .liquid-clear-control:active:not(:disabled) {
          transform: translateY(1px) scale(0.972);
          filter: brightness(0.93);
          box-shadow:
            0 7px 18px rgba(15, 23, 42, 0.18),
            inset 0 3px 10px rgba(15, 23, 42, 0.22),
            inset 0 1px 0 rgba(255, 255, 255, 0.18) !important;
        }

        /* =========================================================
           Final selection-state override
           - Put this after every generic liquid button rule.
           - Selected controls must stay black glass.
           - Unselected controls must stay transparent glass.
           - Disabled controls keep transparent glass and gray text only.
           ========================================================= */
        .race-root button.liquid-selected-control:not(:disabled),
        .race-root-setup button.liquid-selected-control:not(:disabled),
        .race-root-setup button.distance-preset-button.liquid-selected-control:not(:disabled),
        .race-root-setup button.liquid-choice-button.liquid-selected-control:not(:disabled),
        .run-settings-panel button.liquid-selected-control:not(:disabled),
        button.liquid-selected-control:not(:disabled) {
          border-color: rgba(255, 255, 255, 0.52) !important;
          background-color: rgba(8, 13, 23, 0.88) !important;
          background-image:
            radial-gradient(
              circle at 24% 0%,
              rgba(255, 255, 255, 0.26),
              transparent 38%
            ),
            linear-gradient(
              135deg,
              rgba(8, 13, 23, 0.92),
              rgba(17, 24, 39, 0.78) 48%,
              rgba(31, 41, 55, 0.66)
            ) !important;
          color: rgba(255, 255, 255, 0.98) !important;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.40) !important;
          opacity: 1 !important;
          filter: none !important;
          backdrop-filter: blur(30px) saturate(185%) brightness(1.02) !important;
          -webkit-backdrop-filter: blur(30px) saturate(185%) brightness(1.02) !important;
          box-shadow:
            0 16px 38px rgba(15, 23, 42, 0.24),
            inset 0 1px 0 rgba(255, 255, 255, 0.36),
            inset 0 -1px 0 rgba(255, 255, 255, 0.10) !important;
        }

        .race-root button.liquid-selected-control:not(:disabled)::before,
        .race-root-setup button.liquid-selected-control:not(:disabled)::before,
        .race-root-setup button.distance-preset-button.liquid-selected-control:not(:disabled)::before,
        .race-root-setup button.liquid-choice-button.liquid-selected-control:not(:disabled)::before,
        .run-settings-panel button.liquid-selected-control:not(:disabled)::before,
        button.liquid-selected-control:not(:disabled)::before {
          content: "";
          position: absolute;
          inset: 1px;
          z-index: -1;
          border-radius: inherit;
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.30),
              rgba(255, 255, 255, 0.07) 42%,
              transparent 70%
            ) !important;
          opacity: 0.88 !important;
          pointer-events: none;
          filter: url("#liquid-glass-soft");
        }

        .race-root button.liquid-selected-control:not(:disabled) *,
        .race-root-setup button.liquid-selected-control:not(:disabled) *,
        .run-settings-panel button.liquid-selected-control:not(:disabled) *,
        button.liquid-selected-control:not(:disabled) * {
          color: rgba(255, 255, 255, 0.98) !important;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.34) !important;
        }

        .race-root button.liquid-clear-control:not(:disabled),
        .race-root-setup button.liquid-clear-control:not(:disabled),
        .race-root-setup button.distance-preset-button.liquid-clear-control:not(:disabled),
        .race-root-setup button.liquid-choice-button.liquid-clear-control:not(:disabled),
        .run-settings-panel button.liquid-clear-control:not(:disabled),
        button.liquid-clear-control:not(:disabled) {
          border-color: rgba(148, 163, 184, 0.34) !important;
          background-color: rgba(255, 255, 255, 0.10) !important;
          background-image:
            radial-gradient(
              circle at 24% 0%,
              rgba(255, 255, 255, 0.42),
              transparent 36%
            ),
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.19),
              rgba(255, 255, 255, 0.04)
            ) !important;
          color: rgba(15, 23, 42, 0.92) !important;
          text-shadow: none !important;
          opacity: 1 !important;
          backdrop-filter: blur(30px) saturate(175%) brightness(1.04) !important;
          -webkit-backdrop-filter: blur(30px) saturate(175%) brightness(1.04) !important;
          box-shadow:
            0 10px 24px rgba(15, 23, 42, 0.055),
            inset 0 1px 0 rgba(255, 255, 255, 0.76),
            inset 0 -1px 0 rgba(15, 23, 42, 0.04) !important;
        }

        .race-root button.liquid-clear-control:not(:disabled) *,
        .race-root-setup button.liquid-clear-control:not(:disabled) *,
        .run-settings-panel button.liquid-clear-control:not(:disabled) *,
        button.liquid-clear-control:not(:disabled) * {
          color: rgba(15, 23, 42, 0.92) !important;
          text-shadow: none !important;
        }

        .race-root button.liquid-selected-control:disabled,
        .race-root button.liquid-clear-control:disabled,
        .race-root-setup button.liquid-selected-control:disabled,
        .race-root-setup button.liquid-clear-control:disabled,
        .run-settings-panel button.liquid-selected-control:disabled,
        .run-settings-panel button.liquid-clear-control:disabled,
        button.liquid-selected-control:disabled,
        button.liquid-clear-control:disabled {
          border-color: rgba(148, 163, 184, 0.24) !important;
          background-color: rgba(255, 255, 255, 0.08) !important;
          background-image:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.12),
              rgba(255, 255, 255, 0.03)
            ) !important;
          color: rgba(100, 116, 139, 0.56) !important;
          text-shadow: none !important;
          opacity: 1 !important;
          filter: none !important;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.48),
            0 8px 18px rgba(15, 23, 42, 0.035) !important;
        }

        .race-root button.liquid-selected-control:disabled *,
        .race-root button.liquid-clear-control:disabled *,
        .race-root-setup button.liquid-selected-control:disabled *,
        .race-root-setup button.liquid-clear-control:disabled *,
        .run-settings-panel button.liquid-selected-control:disabled *,
        .run-settings-panel button.liquid-clear-control:disabled *,
        button.liquid-selected-control:disabled *,
        button.liquid-clear-control:disabled * {
          color: rgba(100, 116, 139, 0.56) !important;
          text-shadow: none !important;
        }


        /* =========================================================
           Mobile map overlay separation
           - Candidate list, top tabs, and location control get fixed lanes.
           - Prevents overlap after route search on mobile browsers.
           ========================================================= */
        @media (max-width: 767px) {
          .race-root-map.race-root-auto-loop-open .race-top-tabs {
            z-index: 90;
            top: max(8px, env(safe-area-inset-top));
            left: 10px;
            right: 10px;
          }

          .race-root-map.race-root-auto-loop-open .map-location-control {
            z-index: 88;
            top: calc(max(8px, env(safe-area-inset-top)) + 58px);
            left: 10px;
            right: 10px;
            max-width: none;
            width: auto;
            display: flex;
            flex-direction: row;
            align-items: center;
            justify-content: flex-end;
            gap: 8px;
          }

          .race-root-map.race-root-auto-loop-open .map-location-button {
            min-height: 42px;
            padding: 10px 14px;
            white-space: nowrap;
          }

          .race-root-map.race-root-auto-loop-open .map-location-meta {
            display: none;
          }

          .race-root-map.race-root-auto-loop-open .race-auto-loop-panel {
            z-index: 70;
            top: calc(max(8px, env(safe-area-inset-top)) + 112px);
            bottom: max(10px, env(safe-area-inset-bottom));
            left: 10px;
            right: 10px;
            max-height: none;
            border-radius: 24px;
            padding: 12px;
          }

          .race-root-map.race-root-auto-loop-open.race-root-auto-loop-collapsed .race-auto-loop-panel {
            top: auto;
            max-height: 110px;
          }

          .race-root-map.race-root-auto-loop-open .race-auto-loop-panel > .mb-2 {
            position: sticky;
            top: 0;
            z-index: 2;
            margin: -2px -2px 8px -2px;
            border-radius: 18px;
            padding: 8px;
            background: linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.78),
              rgba(255, 255, 255, 0.36)
            );
            backdrop-filter: blur(22px) saturate(170%);
            -webkit-backdrop-filter: blur(22px) saturate(170%);
            box-shadow:
              0 10px 24px rgba(15, 23, 42, 0.08),
              inset 0 1px 0 rgba(255, 255, 255, 0.76);
          }
        }

        @media (max-width: 480px) {
          .race-root-map.race-root-auto-loop-open .race-auto-loop-panel .rounded-lg.border > .flex.items-start.justify-between.gap-2 {
            flex-direction: column;
          }

          .race-root-map.race-root-auto-loop-open .race-auto-loop-panel .rounded-lg.border > .flex.items-start.justify-between.gap-2 > .flex.shrink-0.flex-col.gap-1 {
            width: 100%;
            flex-direction: row;
          }

          .race-root-map.race-root-auto-loop-open .race-auto-loop-panel .rounded-lg.border > .flex.items-start.justify-between.gap-2 > .flex.shrink-0.flex-col.gap-1 > button {
            flex: 1 1 0;
            min-height: 42px;
          }

          .race-root-map.race-root-auto-loop-open .race-auto-loop-panel {
            left: 8px;
            right: 8px;
            padding: 10px;
          }
        }


        /* =========================================================
           Mobile collapsed candidate sheet must stay at the bottom.
           This intentionally overrides the expanded candidate sheet top lane.
           ========================================================= */
        @media (max-width: 767px) {
          .race-root-map.race-root-auto-loop-open.race-root-auto-loop-collapsed .race-auto-loop-panel {
            top: auto !important;
            bottom: calc(max(10px, env(safe-area-inset-bottom)) + 8px) !important;
            left: 10px !important;
            right: 10px !important;
            height: auto !important;
            min-height: 0 !important;
            max-height: 116px !important;
            overflow: hidden !important;
            transform: none !important;
            border-radius: 22px !important;
            z-index: 72 !important;
          }

          .race-root-map.race-root-auto-loop-open.race-root-auto-loop-collapsed .race-auto-loop-panel > .mb-2 {
            position: relative !important;
            top: auto !important;
            z-index: 2 !important;
            margin: 0 !important;
            border-radius: 18px !important;
            padding: 8px !important;
          }

          .race-root-map.race-root-auto-loop-open.race-root-auto-loop-collapsed .race-auto-loop-panel > .mb-2 > div:first-child {
            min-width: 0;
          }

          .race-root-map.race-root-auto-loop-open.race-root-auto-loop-collapsed .race-auto-loop-panel > .mb-2 .text-xs {
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
        }


        /* =========================================================
           Dedicated candidate bottom sheet
           - Route search results are no longer a floating top panel.
           - Expanded and collapsed states are both anchored to bottom.
           - Header controls always remain reachable.
           ========================================================= */
        .race-candidate-bottom-sheet {
          position: absolute !important;
          z-index: 86 !important;
          top: auto !important;
          left: max(10px, env(safe-area-inset-left)) !important;
          right: max(10px, env(safe-area-inset-right)) !important;
          bottom: max(10px, env(safe-area-inset-bottom)) !important;
          display: flex;
          min-height: 0;
          max-height: min(72dvh, 640px);
          flex-direction: column;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.74) !important;
          border-radius: 28px 28px 24px 24px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.68),
              rgba(255, 255, 255, 0.28)
            ) !important;
          color: #0f172a !important;
          backdrop-filter: blur(30px) saturate(185%) !important;
          -webkit-backdrop-filter: blur(30px) saturate(185%) !important;
          box-shadow:
            0 -18px 52px rgba(15, 23, 42, 0.16),
            0 8px 28px rgba(15, 23, 42, 0.10),
            inset 0 1px 0 rgba(255, 255, 255, 0.94),
            inset 0 -1px 0 rgba(255, 255, 255, 0.30) !important;
          padding: 10px;
          transform: none !important;
        }

        .race-candidate-bottom-sheet::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 0;
          background:
            radial-gradient(circle at 20% 0%, rgba(255, 255, 255, 0.78), transparent 36%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.42), transparent 44%),
            radial-gradient(circle at 90% 100%, rgba(191, 219, 254, 0.14), transparent 34%);
          pointer-events: none;
        }

        .race-candidate-bottom-sheet > * {
          position: relative;
          z-index: 1;
        }

        .candidate-bottom-sheet-handle {
          align-self: center;
          width: 42px;
          height: 5px;
          border-radius: 9999px;
          background: rgba(15, 23, 42, 0.18);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
          margin: 0 0 8px 0;
        }

        .candidate-bottom-sheet-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
          flex: 0 0 auto;
          min-height: 0;
          border: 1px solid rgba(255, 255, 255, 0.62);
          border-radius: 20px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.62),
              rgba(255, 255, 255, 0.22)
            );
          padding: 10px;
          box-shadow:
            0 12px 28px rgba(15, 23, 42, 0.08),
            inset 0 1px 0 rgba(255, 255, 255, 0.86);
          backdrop-filter: blur(22px) saturate(170%);
          -webkit-backdrop-filter: blur(22px) saturate(170%);
        }

        .candidate-bottom-sheet-status {
          display: -webkit-box;
          margin-top: 2px;
          overflow: hidden;
          color: rgba(51, 65, 85, 0.84);
          font-size: 12px;
          font-weight: 700;
          line-height: 1.35;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }

        .candidate-bottom-sheet-actions {
          display: flex;
          flex: 0 0 auto;
          gap: 6px;
        }

        .candidate-sheet-control-button,
        .candidate-card-action-button,
        .candidate-sheet-footer-button {
          position: relative;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.66) !important;
          border-radius: 16px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.62),
              rgba(255, 255, 255, 0.20)
            ) !important;
          color: #0f172a !important;
          font-size: 12px;
          font-weight: 900;
          line-height: 1;
          padding: 10px 12px;
          text-shadow: none !important;
          backdrop-filter: blur(20px) saturate(170%) !important;
          -webkit-backdrop-filter: blur(20px) saturate(170%) !important;
          box-shadow:
            0 10px 24px rgba(15, 23, 42, 0.09),
            inset 0 1px 0 rgba(255, 255, 255, 0.86),
            inset 0 -1px 0 rgba(255, 255, 255, 0.22) !important;
          transition:
            transform 140ms ease,
            filter 140ms ease,
            box-shadow 140ms ease,
            border-color 140ms ease;
        }

        .candidate-sheet-control-button:active:not(:disabled),
        .candidate-card-action-button:active:not(:disabled),
        .candidate-sheet-footer-button:active:not(:disabled) {
          transform: translateY(1px) scale(0.972);
          filter: brightness(0.94);
        }

        .candidate-bottom-sheet-body {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
          padding-top: 10px;
          padding-right: 2px;
        }

        .candidate-sheet-info-card,
        .candidate-sheet-error-card {
          border: 1px solid rgba(255, 255, 255, 0.58);
          border-radius: 16px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.54),
              rgba(255, 255, 255, 0.18)
            );
          padding: 10px;
          box-shadow:
            0 10px 26px rgba(15, 23, 42, 0.07),
            inset 0 1px 0 rgba(255, 255, 255, 0.78);
          backdrop-filter: blur(20px) saturate(165%);
          -webkit-backdrop-filter: blur(20px) saturate(165%);
        }

        .candidate-sheet-error-card {
          background:
            linear-gradient(
              135deg,
              rgba(254, 242, 242, 0.72),
              rgba(255, 255, 255, 0.24)
            );
        }

        .candidate-course-card {
          border: 1px solid rgba(255, 255, 255, 0.62);
          border-radius: 18px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.62),
              rgba(255, 255, 255, 0.22)
            );
          padding: 10px;
          box-shadow:
            0 12px 30px rgba(15, 23, 42, 0.09),
            inset 0 1px 0 rgba(255, 255, 255, 0.82);
          backdrop-filter: blur(22px) saturate(175%);
          -webkit-backdrop-filter: blur(22px) saturate(175%);
        }

        .candidate-course-card-previewing {
          border-color: rgba(59, 130, 246, 0.36);
          box-shadow:
            0 14px 34px rgba(59, 130, 246, 0.13),
            inset 0 1px 0 rgba(255, 255, 255, 0.82);
        }

        .candidate-course-card-warning {
          border-color: rgba(234, 179, 8, 0.34);
        }

        .candidate-course-card-ok {
          border-color: rgba(16, 185, 129, 0.30);
        }

        .candidate-course-card-content {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
        }

        .candidate-course-card-actions {
          display: flex;
          flex: 0 0 148px;
          flex-direction: column;
          gap: 6px;
        }

        .candidate-card-action-button {
          min-height: 40px;
          width: 100%;
        }

        .candidate-card-action-button-active,
        .candidate-card-action-button-primary,
        .candidate-sheet-footer-button-primary {
          border-color: rgba(255, 255, 255, 0.52) !important;
          background:
            linear-gradient(
              135deg,
              rgba(15, 23, 42, 0.88),
              rgba(30, 41, 59, 0.62)
            ) !important;
          color: rgba(255, 255, 255, 0.98) !important;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.28) !important;
          box-shadow:
            0 14px 30px rgba(15, 23, 42, 0.16),
            inset 0 1px 0 rgba(255, 255, 255, 0.24),
            inset 0 -1px 0 rgba(255, 255, 255, 0.08) !important;
        }

        .candidate-sheet-footer-button:disabled {
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.16),
              rgba(255, 255, 255, 0.05)
            ) !important;
          color: rgba(100, 116, 139, 0.58) !important;
          text-shadow: none !important;
        }

        .race-candidate-bottom-sheet-collapsed {
          bottom: max(10px, env(safe-area-inset-bottom)) !important;
          max-height: none !important;
          height: auto !important;
          min-height: 0 !important;
        }

        .race-candidate-bottom-sheet-collapsed .candidate-bottom-sheet-handle {
          margin-bottom: 7px;
        }

        .race-candidate-bottom-sheet-collapsed .candidate-bottom-sheet-header {
          min-height: 76px;
          align-items: center;
        }

        @media (min-width: 768px) {
          .race-candidate-bottom-sheet {
            left: 50% !important;
            right: auto !important;
            width: min(620px, calc(100vw - 32px));
            max-height: min(76dvh, 720px);
            transform: translateX(-50%) !important;
          }

          .race-candidate-bottom-sheet-collapsed {
            width: min(520px, calc(100vw - 32px));
          }
        }

        @media (max-width: 767px) {
          .race-root-map.race-root-auto-loop-open .race-candidate-bottom-sheet {
            top: auto !important;
            bottom: max(10px, env(safe-area-inset-bottom)) !important;
            left: max(8px, env(safe-area-inset-left)) !important;
            right: max(8px, env(safe-area-inset-right)) !important;
            max-height: min(72dvh, calc(100dvh - 118px));
            border-radius: 26px 26px 22px 22px;
            padding: 9px;
          }

          .race-root-map.race-root-auto-loop-open.race-root-auto-loop-collapsed .race-candidate-bottom-sheet,
          .race-root-map .race-candidate-bottom-sheet-collapsed {
            top: auto !important;
            bottom: max(10px, env(safe-area-inset-bottom)) !important;
            max-height: none !important;
            transform: none !important;
          }

          .candidate-bottom-sheet-header {
            gap: 8px;
            padding: 9px;
          }

          .candidate-bottom-sheet-actions {
            gap: 5px;
          }

          .candidate-sheet-control-button {
            min-height: 40px;
            padding: 9px 11px;
          }

          .candidate-course-card-content {
            flex-direction: column;
          }

          .candidate-course-card-actions {
            width: 100%;
            flex: 1 1 auto;
            flex-direction: row;
          }

          .candidate-course-card-actions > button {
            flex: 1 1 0;
          }
        }

        @media (max-width: 420px) {
          .candidate-bottom-sheet-header {
            align-items: stretch;
            flex-direction: column;
          }

          .candidate-bottom-sheet-actions {
            display: grid;
            grid-template-columns: 1fr 1fr;
            width: 100%;
          }

          .race-candidate-bottom-sheet-collapsed .candidate-bottom-sheet-header {
            min-height: 0;
          }
        }


        /* =========================================================
           Bottom sheet stabilization pass
           - Candidate, Map HUD, and Custom Course panels all anchor to bottom
           - Drag handle supports swipe up/down collapse state
           - Custom course shows live point-based estimated length
           ========================================================= */
        .bottom-sheet-drag-handle {
          touch-action: none;
          cursor: grab;
          user-select: none;
        }

        .bottom-sheet-drag-handle:active {
          cursor: grabbing;
        }

        .race-map-bottom-sheet,
        .race-custom-bottom-sheet,
        .race-draw-bottom-sheet,
        .race-candidate-bottom-sheet {
          position: absolute !important;
          z-index: 45 !important;
          top: auto !important;
          left: max(8px, env(safe-area-inset-left)) !important;
          right: max(8px, env(safe-area-inset-right)) !important;
          bottom: max(10px, env(safe-area-inset-bottom)) !important;
          width: auto !important;
          transform: none !important;
          border-radius: 26px 26px 22px 22px !important;
          padding: 9px !important;
          overflow: hidden !important;
        }

        .race-map-bottom-sheet.race-map-hud-open {
          max-height: min(58dvh, 480px) !important;
        }

        .race-map-bottom-sheet.race-map-hud-collapsed {
          max-height: none !important;
          height: auto !important;
        }

        .race-custom-bottom-sheet {
          max-height: min(72dvh, 620px) !important;
        }

        .race-draw-bottom-sheet {
          max-height: min(58dvh, 460px) !important;
        }

        .race-custom-bottom-sheet.race-custom-panel-collapsed {
          max-height: none !important;
          height: auto !important;
        }

        .race-draw-bottom-sheet.race-draw-panel-collapsed {
          max-height: none !important;
          height: auto !important;
        }

        .map-bottom-sheet-header,
        .custom-bottom-sheet-header,
        .draw-bottom-sheet-header {
          position: relative;
          z-index: 1;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          border-radius: 20px;
          padding: 10px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.42),
              rgba(255, 255, 255, 0.14)
            );
          border: 1px solid rgba(255, 255, 255, 0.52);
          backdrop-filter: blur(20px) saturate(170%);
          -webkit-backdrop-filter: blur(20px) saturate(170%);
        }

        .map-bottom-sheet-body,
        .custom-bottom-sheet-body,
        .draw-bottom-sheet-body,
        .candidate-bottom-sheet-body {
          position: relative;
          z-index: 1;
          max-height: calc(min(72dvh, 620px) - 94px);
          overflow-y: auto;
          padding: 9px 1px 1px;
          -webkit-overflow-scrolling: touch;
        }

        .map-bottom-sheet-body {
          max-height: calc(min(58dvh, 480px) - 94px);
        }

        .draw-bottom-sheet-body {
          max-height: calc(min(58dvh, 460px) - 94px);
        }

        .custom-distance-summary-card,
        .draw-route-summary-card,
        .draw-route-guide-card,
        .draw-route-mode-toggle-card {
          border: 1px solid rgba(255, 255, 255, 0.62);
          border-radius: 18px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.58),
              rgba(255, 255, 255, 0.18)
            );
          padding: 11px 12px;
          margin-bottom: 10px;
          box-shadow:
            0 10px 24px rgba(15, 23, 42, 0.08),
            inset 0 1px 0 rgba(255, 255, 255, 0.78);
          backdrop-filter: blur(20px) saturate(170%);
          -webkit-backdrop-filter: blur(20px) saturate(170%);
        }

        .race-map-bottom-sheet .candidate-bottom-sheet-handle,
        .race-custom-bottom-sheet .candidate-bottom-sheet-handle,
        .race-draw-bottom-sheet .candidate-bottom-sheet-handle {
          width: 46px;
          height: 5px;
          border-radius: 9999px;
          margin: 1px auto 8px;
          background: rgba(15, 23, 42, 0.24);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
        }

        .race-map-hud-collapsed .map-bottom-sheet-header,
        .race-custom-panel-collapsed .custom-bottom-sheet-header,
        .race-draw-panel-collapsed .draw-bottom-sheet-header,
        .race-candidate-bottom-sheet-collapsed .candidate-bottom-sheet-header {
          min-height: 68px;
        }

        @media (min-width: 768px) {
          .race-map-bottom-sheet,
          .race-custom-bottom-sheet,
          .race-draw-bottom-sheet,
          .race-candidate-bottom-sheet {
            left: 50% !important;
            right: auto !important;
            width: min(620px, calc(100vw - 32px)) !important;
            transform: translateX(-50%) !important;
          }

          .race-map-bottom-sheet.race-map-hud-collapsed,
          .race-custom-bottom-sheet.race-custom-panel-collapsed,
          .race-draw-bottom-sheet.race-draw-panel-collapsed,
          .race-candidate-bottom-sheet-collapsed {
            width: min(520px, calc(100vw - 32px)) !important;
          }
        }

        @media (orientation: landscape) and (max-height: 560px) {
          .race-map-bottom-sheet,
          .race-custom-bottom-sheet,
          .race-draw-bottom-sheet,
          .race-candidate-bottom-sheet {
            top: auto !important;
            bottom: max(8px, env(safe-area-inset-bottom)) !important;
            left: max(8px, env(safe-area-inset-left)) !important;
            right: max(8px, env(safe-area-inset-right)) !important;
            width: auto !important;
            max-height: min(74dvh, calc(100dvh - 92px)) !important;
            transform: none !important;
          }
        }

        @media (max-width: 420px) {
          .map-bottom-sheet-header,
          .custom-bottom-sheet-header,
          .draw-bottom-sheet-header {
            align-items: stretch;
            flex-direction: column;
          }

          .map-bottom-sheet-header > .flex,
          .custom-bottom-sheet-header > .flex,
          .draw-bottom-sheet-header > .flex {
            display: grid;
            grid-template-columns: 1fr 1fr;
            width: 100%;
          }
        }


        /* =========================================================
           Pointer-follow bottom sheet drag + custom route mode toggle
           ========================================================= */
        .race-map-bottom-sheet,
        .race-custom-bottom-sheet,
        .race-draw-bottom-sheet,
        .race-candidate-bottom-sheet {
          transform: translateY(var(--sheet-drag-y, 0px)) !important;
          transition:
            transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
            max-height 180ms ease,
            height 180ms ease;
          will-change: transform;
        }

        @media (min-width: 768px) {
          .race-map-bottom-sheet,
          .race-custom-bottom-sheet,
          .race-draw-bottom-sheet,
          .race-candidate-bottom-sheet {
            transform: translateX(-50%) translateY(var(--sheet-drag-y, 0px)) !important;
          }
        }

        @media (orientation: landscape) and (max-height: 560px) {
          .race-map-bottom-sheet,
          .race-custom-bottom-sheet,
          .race-draw-bottom-sheet,
          .race-candidate-bottom-sheet {
            transform: translateY(var(--sheet-drag-y, 0px)) !important;
          }
        }

        .custom-route-mode-toggle-card {
          border: 1px solid rgba(255, 255, 255, 0.62);
          border-radius: 18px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.58),
              rgba(255, 255, 255, 0.18)
            );
          padding: 11px 12px;
          margin-bottom: 10px;
          box-shadow:
            0 10px 24px rgba(15, 23, 42, 0.08),
            inset 0 1px 0 rgba(255, 255, 255, 0.78);
          backdrop-filter: blur(20px) saturate(170%);
          -webkit-backdrop-filter: blur(20px) saturate(170%);
        }

        .race-custom-bottom-sheet .liquid-selected-control:not(:disabled) {
          border-color: rgba(255, 255, 255, 0.52) !important;
          background:
            linear-gradient(
              135deg,
              rgba(15, 23, 42, 0.90),
              rgba(30, 41, 59, 0.66)
            ) !important;
          color: rgba(255, 255, 255, 0.98) !important;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.28) !important;
        }

        .race-custom-bottom-sheet .liquid-clear-control:not(:disabled) {
          border-color: rgba(255, 255, 255, 0.72) !important;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.36),
              rgba(255, 255, 255, 0.10)
            ) !important;
          color: #0f172a !important;
        }


        .draw-route-live-distance-badge {
          position: absolute;
          z-index: 58;
          top: calc(max(8px, env(safe-area-inset-top)) + 108px);
          left: 50%;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          max-width: calc(100vw - 36px);
          transform: translateX(-50%);
          border: 1px solid rgba(255, 255, 255, 0.72);
          border-radius: 9999px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.70),
              rgba(255, 255, 255, 0.24)
            );
          color: #0f172a;
          padding: 8px 13px;
          font-size: 12px;
          font-weight: 900;
          line-height: 1;
          pointer-events: none;
          white-space: nowrap;
          backdrop-filter: blur(22px) saturate(175%);
          -webkit-backdrop-filter: blur(22px) saturate(175%);
          box-shadow:
            0 14px 34px rgba(15, 23, 42, 0.14),
            inset 0 1px 0 rgba(255, 255, 255, 0.86),
            inset 0 -1px 0 rgba(255, 255, 255, 0.28);
        }

        .draw-route-live-distance-badge span {
          color: rgba(51, 65, 85, 0.72);
          font-size: 11px;
          font-weight: 800;
        }

        .draw-route-live-distance-badge strong {
          color: #0f172a;
          font-size: 13px;
          font-weight: 950;
        }

        .draw-route-live-distance-badge-active {
          border-color: rgba(15, 23, 42, 0.22);
          background:
            linear-gradient(
              135deg,
              rgba(15, 23, 42, 0.84),
              rgba(30, 41, 59, 0.58)
            );
          color: rgba(255, 255, 255, 0.98);
          box-shadow:
            0 18px 42px rgba(15, 23, 42, 0.22),
            inset 0 1px 0 rgba(255, 255, 255, 0.24);
        }

        .draw-route-live-distance-badge-active span,
        .draw-route-live-distance-badge-active strong {
          color: rgba(255, 255, 255, 0.96);
        }

        /* =========================================================
           Draw route mode
           - Dedicated map drawing layer above Mapbox and below sheets
           - All new map modes remain bottom-sheet based
           ========================================================= */
        .draw-route-gesture-layer {
          position: absolute;
          inset: 0;
          z-index: 36;
          touch-action: none;
          cursor: crosshair;
          background: transparent;
        }

        .draw-route-mode-toggle-card {
          margin-bottom: 10px;
        }

        .race-draw-bottom-sheet {
          z-index: 46 !important;
        }

        .draw-route-mode-toggle-card + .draw-route-summary-card {
          margin-top: 10px;
        }

        .draw-route-summary-card-compact {
          margin-bottom: 8px;
        }

        .draw-route-action-row {
          position: sticky;
          bottom: 0;
          z-index: 3;
          margin-top: 8px;
          padding-top: 8px;
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.10),
              rgba(255, 255, 255, 0.68) 38%,
              rgba(255, 255, 255, 0.86)
            );
          backdrop-filter: blur(18px) saturate(165%);
          -webkit-backdrop-filter: blur(18px) saturate(165%);
        }

        .candidate-sheet-control-button-primary:not(:disabled) {
          border-color: rgba(255, 255, 255, 0.52) !important;
          background:
            linear-gradient(
              135deg,
              rgba(15, 23, 42, 0.90),
              rgba(30, 41, 59, 0.66)
            ) !important;
          color: rgba(255, 255, 255, 0.98) !important;
        }

        .race-draw-bottom-sheet .liquid-selected-control:not(:disabled),
        .race-draw-bottom-sheet button.bg-blue-600:not(:disabled) {
          border-color: rgba(255, 255, 255, 0.52) !important;
          background:
            linear-gradient(
              135deg,
              rgba(15, 23, 42, 0.90),
              rgba(30, 41, 59, 0.66)
            ) !important;
          color: rgba(255, 255, 255, 0.98) !important;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.28) !important;
        }



        /* =========================================================
           Phase 1 mobile map UI cleanup
           - Smaller bottom sheets
           - Iconized collapse/close controls
           - Tap handle to open/collapse
           - Floating pen/hand mode controls outside draw sheet
           ========================================================= */
        .candidate-bottom-sheet-handle,
        .race-map-bottom-sheet .candidate-bottom-sheet-handle,
        .race-custom-bottom-sheet .candidate-bottom-sheet-handle,
        .race-draw-bottom-sheet .candidate-bottom-sheet-handle {
          width: 46px !important;
          height: 4px !important;
          min-height: 4px !important;
          margin: 2px auto 7px !important;
          padding: 0 !important;
          border: 0 !important;
          border-radius: 9999px !important;
          background: rgba(15, 23, 42, 0.24) !important;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.62) !important;
          appearance: none !important;
          -webkit-appearance: none !important;
        }

        .candidate-bottom-sheet-handle:focus-visible {
          outline: 2px solid rgba(37, 99, 235, 0.42);
          outline-offset: 4px;
        }

        .bottom-sheet-icon-actions {
          align-items: flex-start !important;
          gap: 5px !important;
        }

        .bottom-sheet-icon-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          flex: 0 0 34px;
          border: 1px solid rgba(255, 255, 255, 0.66) !important;
          border-radius: 9999px !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.58), rgba(255, 255, 255, 0.16)) !important;
          color: rgba(15, 23, 42, 0.88) !important;
          font-size: 19px;
          font-weight: 950;
          line-height: 1;
          text-shadow: none !important;
          backdrop-filter: blur(20px) saturate(170%) !important;
          -webkit-backdrop-filter: blur(20px) saturate(170%) !important;
          box-shadow:
            0 10px 22px rgba(15, 23, 42, 0.10),
            inset 0 1px 0 rgba(255, 255, 255, 0.86) !important;
        }

        .bottom-sheet-icon-button:active:not(:disabled) {
          transform: translateY(1px) scale(0.94);
          filter: brightness(0.94);
        }

        .bottom-sheet-text-control-button {
          min-height: 34px !important;
          padding: 9px 11px !important;
          white-space: nowrap;
        }

        .race-candidate-bottom-sheet,
        .race-map-bottom-sheet,
        .race-custom-bottom-sheet,
        .race-draw-bottom-sheet {
          border-radius: 24px 24px 20px 20px !important;
          padding: 8px !important;
        }

        .race-candidate-bottom-sheet {
          max-height: min(54dvh, 470px) !important;
        }

        .race-map-bottom-sheet.race-map-hud-open {
          max-height: min(46dvh, 380px) !important;
        }

        .race-custom-bottom-sheet {
          max-height: min(60dvh, 500px) !important;
        }

        .race-draw-bottom-sheet {
          max-height: min(38dvh, 330px) !important;
        }

        .candidate-bottom-sheet-header,
        .map-bottom-sheet-header,
        .custom-bottom-sheet-header,
        .draw-bottom-sheet-header {
          align-items: center !important;
          border-radius: 18px !important;
          padding: 8px 9px !important;
          gap: 8px !important;
        }

        .candidate-bottom-sheet-header .text-sm,
        .map-bottom-sheet-header .text-sm,
        .custom-bottom-sheet-header .text-sm,
        .draw-bottom-sheet-header .text-sm {
          font-size: 13px !important;
        }

        .candidate-bottom-sheet-status,
        .map-bottom-sheet-header .text-xs,
        .custom-bottom-sheet-header .text-xs,
        .draw-bottom-sheet-header .text-xs {
          font-size: 11px !important;
          line-height: 1.25 !important;
          -webkit-line-clamp: 1;
        }

        .candidate-bottom-sheet-body,
        .map-bottom-sheet-body,
        .custom-bottom-sheet-body,
        .draw-bottom-sheet-body {
          padding-top: 7px !important;
        }

        .candidate-course-card {
          border-radius: 16px !important;
          padding: 8px !important;
        }

        .candidate-course-card-content {
          gap: 8px !important;
        }

        .candidate-course-card-actions {
          flex: 0 0 118px !important;
          gap: 5px !important;
        }

        .candidate-card-action-button {
          min-height: 34px !important;
          border-radius: 14px !important;
          padding: 8px 9px !important;
          font-size: 11px !important;
        }

        .candidate-sheet-control-button,
        .candidate-sheet-footer-button {
          min-height: 34px !important;
          border-radius: 14px !important;
          padding: 8px 10px !important;
          font-size: 11px !important;
        }

        .candidate-sheet-info-card,
        .candidate-sheet-error-card,
        .custom-distance-summary-card,
        .draw-route-summary-card,
        .draw-route-guide-card,
        .custom-route-mode-toggle-card {
          border-radius: 15px !important;
          padding: 8px 9px !important;
          margin-bottom: 7px !important;
        }

        .draw-route-summary-card-compact {
          display: none !important;
        }

        .draw-route-floating-mode-controls {
          position: absolute;
          z-index: 64;
          top: calc(max(8px, env(safe-area-inset-top)) + 186px);
          right: max(12px, env(safe-area-inset-right));
          display: flex;
          flex-direction: column;
          gap: 8px;
          pointer-events: auto;
        }

        .draw-route-floating-mode-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 46px;
          height: 46px;
          border: 1px solid rgba(255, 255, 255, 0.72) !important;
          border-radius: 9999px !important;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.68), rgba(255, 255, 255, 0.18)) !important;
          color: rgba(15, 23, 42, 0.88) !important;
          font-size: 21px;
          font-weight: 950;
          line-height: 1;
          backdrop-filter: blur(24px) saturate(175%) !important;
          -webkit-backdrop-filter: blur(24px) saturate(175%) !important;
          box-shadow:
            0 16px 34px rgba(15, 23, 42, 0.13),
            inset 0 1px 0 rgba(255, 255, 255, 0.90),
            inset 0 -1px 0 rgba(255, 255, 255, 0.24) !important;
        }

        .draw-route-floating-mode-button:active:not(:disabled) {
          transform: translateY(1px) scale(0.94);
          filter: brightness(0.94);
        }

        .draw-route-floating-mode-button:disabled {
          color: rgba(100, 116, 139, 0.48) !important;
          cursor: not-allowed;
        }

        .draw-route-floating-mode-active:not(:disabled) {
          border-color: rgba(255, 255, 255, 0.52) !important;
          background:
            linear-gradient(135deg, rgba(15, 23, 42, 0.90), rgba(30, 41, 59, 0.66)) !important;
          color: rgba(255, 255, 255, 0.98) !important;
          box-shadow:
            0 18px 38px rgba(15, 23, 42, 0.20),
            inset 0 1px 0 rgba(255, 255, 255, 0.24),
            inset 0 -1px 0 rgba(255, 255, 255, 0.08) !important;
        }

        @media (max-width: 420px) {
          .map-bottom-sheet-header,
          .custom-bottom-sheet-header,
          .draw-bottom-sheet-header {
            align-items: center !important;
            flex-direction: row !important;
          }

          .map-bottom-sheet-header > .flex,
          .custom-bottom-sheet-header > .flex,
          .draw-bottom-sheet-header > .flex {
            display: flex !important;
            grid-template-columns: none !important;
            width: auto !important;
          }

          .candidate-course-card-content {
            flex-direction: row !important;
          }

          .candidate-course-card-actions {
            flex: 0 0 104px !important;
          }
        }


        /* Course search cancellation controls */
        .course-search-stop-button,
        .candidate-sheet-stop-button {
          border: 1px solid rgba(248, 113, 113, 0.36) !important;
          border-radius: 16px !important;
          background:
            linear-gradient(135deg, rgba(254, 242, 242, 0.72), rgba(255, 255, 255, 0.22)) !important;
          color: #b91c1c !important;
          text-shadow: none !important;
          backdrop-filter: blur(22px) saturate(170%) !important;
          -webkit-backdrop-filter: blur(22px) saturate(170%) !important;
          box-shadow:
            0 14px 32px rgba(185, 28, 28, 0.10),
            inset 0 1px 0 rgba(255, 255, 255, 0.82),
            inset 0 -1px 0 rgba(255, 255, 255, 0.28) !important;
        }

        .candidate-sheet-stop-button {
          white-space: nowrap;
        }

        /* =========================================================
           Phase 1 follow-up fixes
           - Move draw/move floating controls below the setup tab
           - Keep every bottom-sheet handle centered
           - Place collapse/close controls at the handle row on the top-right
           - Lock incompatible course-picking modes from setup
           ========================================================= */
        .race-root-map .draw-route-floating-mode-controls {
          top: calc(max(8px, env(safe-area-inset-top)) + 82px) !important;
          left: max(18px, env(safe-area-inset-left)) !important;
          right: auto !important;
          flex-direction: row !important;
          gap: 8px !important;
        }

        .race-root-map .draw-route-floating-mode-button {
          width: 42px !important;
          height: 42px !important;
          flex: 0 0 42px !important;
          font-size: 20px !important;
        }

        .race-candidate-bottom-sheet,
        .race-map-bottom-sheet,
        .race-custom-bottom-sheet,
        .race-draw-bottom-sheet {
          position: fixed !important;
          overflow: hidden !important;
        }

        .race-candidate-bottom-sheet .candidate-bottom-sheet-handle,
        .race-map-bottom-sheet .candidate-bottom-sheet-handle,
        .race-custom-bottom-sheet .candidate-bottom-sheet-handle,
        .race-draw-bottom-sheet .candidate-bottom-sheet-handle {
          display: block !important;
          position: relative !important;
          left: auto !important;
          right: auto !important;
          top: auto !important;
          transform: none !important;
          width: 46px !important;
          height: 4px !important;
          min-height: 4px !important;
          margin: 4px auto 7px !important;
        }

        .race-candidate-bottom-sheet .bottom-sheet-icon-actions,
        .race-map-bottom-sheet .bottom-sheet-icon-actions,
        .race-custom-bottom-sheet .bottom-sheet-icon-actions,
        .race-draw-bottom-sheet .bottom-sheet-icon-actions {
          position: absolute !important;
          top: 8px !important;
          right: 10px !important;
          z-index: 8 !important;
          display: flex !important;
          align-items: center !important;
          justify-content: flex-end !important;
          gap: 5px !important;
          width: auto !important;
          pointer-events: auto !important;
        }

        .race-candidate-bottom-sheet .bottom-sheet-icon-button,
        .race-map-bottom-sheet .bottom-sheet-icon-button,
        .race-custom-bottom-sheet .bottom-sheet-icon-button,
        .race-draw-bottom-sheet .bottom-sheet-icon-button {
          width: 30px !important;
          height: 30px !important;
          flex: 0 0 30px !important;
          font-size: 18px !important;
        }

        .candidate-bottom-sheet-header,
        .map-bottom-sheet-header,
        .custom-bottom-sheet-header,
        .draw-bottom-sheet-header {
          position: relative !important;
          padding-right: 78px !important;
          min-height: 44px !important;
        }

        .race-candidate-bottom-sheet-collapsed .candidate-bottom-sheet-header,
        .race-map-hud-collapsed .map-bottom-sheet-header,
        .race-custom-panel-collapsed .custom-bottom-sheet-header,
        .race-draw-panel-collapsed .draw-bottom-sheet-header {
          min-height: 40px !important;
        }

        .course-action-button:disabled,
        .distance-preset-button:disabled {
          opacity: 0.42 !important;
          filter: grayscale(0.35) !important;
        }

        @media (max-width: 420px) {
          .race-root-map .draw-route-floating-mode-controls {
            top: calc(max(8px, env(safe-area-inset-top)) + 78px) !important;
            left: max(16px, env(safe-area-inset-left)) !important;
          }

          .candidate-bottom-sheet-header,
          .map-bottom-sheet-header,
          .custom-bottom-sheet-header,
          .draw-bottom-sheet-header {
            padding-right: 76px !important;
          }
        }


        /* =========================================================
           Phase 1 polish fix
           - Put minimize/close controls on the same top handle line
           - Keep bottom custom-course action buttons fully visible while scrolling
           ========================================================= */
        .race-candidate-bottom-sheet .candidate-bottom-sheet-header,
        .race-map-bottom-sheet .map-bottom-sheet-header,
        .race-custom-bottom-sheet .custom-bottom-sheet-header,
        .race-draw-bottom-sheet .draw-bottom-sheet-header {
          position: static !important;
        }

        .race-candidate-bottom-sheet .bottom-sheet-icon-actions,
        .race-map-bottom-sheet .bottom-sheet-icon-actions,
        .race-custom-bottom-sheet .bottom-sheet-icon-actions,
        .race-draw-bottom-sheet .bottom-sheet-icon-actions {
          top: 5px !important;
          right: 12px !important;
          transform: none !important;
        }

        .race-candidate-bottom-sheet .candidate-bottom-sheet-handle,
        .race-map-bottom-sheet .candidate-bottom-sheet-handle,
        .race-custom-bottom-sheet .candidate-bottom-sheet-handle,
        .race-draw-bottom-sheet .candidate-bottom-sheet-handle {
          margin-top: 6px !important;
          margin-bottom: 10px !important;
        }

        .race-custom-bottom-sheet .custom-bottom-sheet-body {
          padding-bottom: max(76px, calc(env(safe-area-inset-bottom) + 76px)) !important;
          scroll-padding-bottom: max(92px, calc(env(safe-area-inset-bottom) + 92px)) !important;
        }

        .race-custom-bottom-sheet .custom-course-action-row {
          position: sticky;
          bottom: 8px;
          z-index: 6;
          border: 1px solid rgba(255, 255, 255, 0.58);
          border-radius: 18px;
          background:
            linear-gradient(
              135deg,
              rgba(255, 255, 255, 0.70),
              rgba(255, 255, 255, 0.30)
            );
          padding: 6px;
          box-shadow:
            0 14px 34px rgba(15, 23, 42, 0.12),
            inset 0 1px 0 rgba(255, 255, 255, 0.88);
          backdrop-filter: blur(22px) saturate(175%);
          -webkit-backdrop-filter: blur(22px) saturate(175%);
        }

        .race-custom-bottom-sheet .custom-course-action-row > button {
          min-height: 42px;
          border-radius: 14px;
        }

        @media (max-width: 420px) {
          .race-candidate-bottom-sheet .bottom-sheet-icon-actions,
          .race-map-bottom-sheet .bottom-sheet-icon-actions,
          .race-custom-bottom-sheet .bottom-sheet-icon-actions,
          .race-draw-bottom-sheet .bottom-sheet-icon-actions {
            top: 5px !important;
            right: 10px !important;
          }

          .race-custom-bottom-sheet .custom-bottom-sheet-body {
            padding-bottom: max(86px, calc(env(safe-area-inset-bottom) + 86px)) !important;
          }
        }

      `}</style>

    </div>
  );
}