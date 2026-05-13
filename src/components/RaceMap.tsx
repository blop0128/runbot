"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
}: {
  origin: LngLat;
  token: string;
  targetDistanceM: number;
  toleranceM?: number;
}): Promise<AutoLoopCourseCandidate[]> {
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
    const key = makeCandidateKey(attempt.endpoint);

    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const route = await fetchWalkingRoute([origin, attempt.endpoint], token);

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

  const [activePanel, setActivePanel] = useState<ActivePanel>("setup");
  const [setupView, setSetupView] = useState<SetupView>("main");
  const [isLeaderboardOpen, setIsLeaderboardOpen] = useState(true);
  const [isAutoLoopPanelCollapsed, setIsAutoLoopPanelCollapsed] = useState(false);
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

  const isAutoLoopPanelVisible =
    isGeneratingAutoLoop ||
    isGeneratingOneWay ||
    autoLoopCandidates.length > 0 ||
    autoLoopError !== null;

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
      setCustomGuide("add-turnaround");
      setStatus("시작지점 선택 완료");
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
    if (isRunning) return;

    clearAutoLoopCandidates();
    setIsCustomCourseMode(true);
    setCustomPointStep("start");
    setCustomGuide("select-start");
    setCustomPoints(INITIAL_CUSTOM_POINTS);
    setCustomCourseError(null);
    setShouldSaveCustomCourse(true);
    setCustomCourseName("");
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
    clearCustomPointMarkers();
    setStatus("수동 코스 생성을 취소했습니다.");
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
    const finalName =
      trimmedName ||
      `커스텀 코스 ${sortedCourseLibrary.length + 1} · ${
        customPoints.turnaround ? "경유" : "편도"
      }`;

    try {
      setIsGeneratingCustomCourse(true);
      setCustomCourseError(null);
      setStatus("선택한 지점 기준으로 커스텀 코스를 생성하는 중...");

      const nextCourse = await generateCustomWalkingCourse({
        start: customPoints.start,
        turnaround: customPoints.turnaround,
        finish: customPoints.finish,
        token,
        name: finalName,
      });

      let storedCustomCourse: StoredCourseRecord | null = null;

      if (shouldSaveCustomCourse) {
        storedCustomCourse = makeStoredCourseRecord({
          course: nextCourse,
          name: finalName,
          turnaround: customPoints.turnaround,
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
      setActiveCourseTurnaround(customPoints.turnaround);
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
    if (isRunning) return;

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

    const targetDistanceM = parseAutoLoopTargetDistanceM();

    if (!Number.isFinite(targetDistanceM) || targetDistanceM <= 0) {
      setAutoLoopError("목표 거리를 올바르게 입력해 주세요.");
      return;
    }

    try {
      setIsGeneratingAutoLoop(true);
      setStatus("현재 위치를 가져오는 중...");

      const position = await getCurrentPosition();
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

      if (candidates.length === 0) {
        setAutoLoopError("생성 가능한 왕복 후보를 찾지 못했습니다.");
        setStatus("왕복 후보 없음");
        return;
      }

      setAutoLoopAllCandidates(candidates);
      showAutoLoopCandidatePage(candidates, 0, "outAndBack");
    } catch (rawError) {
      const message = getPositionErrorMessage(rawError);

      setAutoLoopError(message);
      setStatus("왕복 후보 생성 실패");
    } finally {
      setIsGeneratingAutoLoop(false);
    }
  }

  async function handleGenerateOneWayCandidates() {
    if (isRunning) return;

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

    const targetDistanceM = parseAutoLoopTargetDistanceM();

    if (!Number.isFinite(targetDistanceM) || targetDistanceM <= 0) {
      setAutoLoopError("목표 거리를 올바르게 입력해 주세요.");
      return;
    }

    try {
      setIsGeneratingOneWay(true);
      setStatus("현재 위치를 가져오는 중...");

      const position = await getCurrentPosition();
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
      });

      if (candidates.length === 0) {
        setAutoLoopError("생성 가능한 편도 후보를 찾지 못했습니다.");
        setStatus("편도 후보 없음");
        return;
      }

      setAutoLoopAllCandidates(candidates);
      showAutoLoopCandidatePage(candidates, 0, "oneWay");
    } catch (rawError) {
      const message = getPositionErrorMessage(rawError);

      setAutoLoopError(message);
      setStatus("편도 후보 생성 실패");
    } finally {
      setIsGeneratingOneWay(false);
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

  const isGeneratingAnyCourse = isGeneratingAutoLoop || isGeneratingOneWay;
  const candidateModeLabel = getCandidateModeLabel(candidateMode);

  const currentMapLocationText = currentMapLocation
    ? `${currentMapLocation[1].toFixed(5)}, ${currentMapLocation[0].toFixed(5)}`
    : "현재 위치 미확인";

  const currentMapLocationAccuracyText =
    currentMapLocationAccuracyM !== null
      ? `정확도 ${currentMapLocationAccuracyM.toFixed(1)}m`
      : "정확도 -";

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
    <div className="race-root">
      <div ref={mapContainerRef} className="race-map" />

      {activePanel === "setup" && <div className="setup-background" />}

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
                  className={`rounded-xl px-3 py-3 text-sm font-bold ${
                    playerMode === "gps"
                      ? "bg-orange-600 text-white"
                      : "bg-slate-100 text-slate-700"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  GPS로 실제 달리기
                </button>

                <button
                  type="button"
                  onClick={() => setPlayerMode("pace")}
                  disabled={isRunning}
                  className={`rounded-xl px-3 py-3 text-sm font-bold ${
                    playerMode === "pace"
                      ? "bg-green-600 text-white"
                      : "bg-slate-100 text-slate-700"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
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
                  className={`rounded-xl px-3 py-3 text-left text-sm font-semibold ${
                    selectedBotIds.length === 0
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-700"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
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
                      className={`rounded-xl px-3 py-3 text-left text-sm font-semibold ${
                        selected
                          ? "bg-blue-600 text-white"
                          : "bg-white text-slate-800 ring-1 ring-slate-200"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
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
                            onClick={() => setAutoLoopTargetKm(preset.value)}
                            disabled={isRunning || isGeneratingAnyCourse}
                            className={`rounded-lg px-3 py-2 text-xs font-black transition disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 ${
                              isActive
                                ? "bg-slate-900 text-white"
                                : "bg-white text-slate-700 ring-1 ring-slate-200"
                            }`}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>

                    <input
                      value={autoLoopTargetKm}
                      onChange={(event) => setAutoLoopTargetKm(event.target.value)}
                      disabled={isRunning || isGeneratingAnyCourse}
                      inputMode="decimal"
                      className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 disabled:bg-slate-100"
                    />
                  </div>

                  <div className="mt-2 grid grid-cols-1 gap-2">
                    <button
                      type="button"
                      onClick={handleGenerateOutAndBackCandidates}
                      disabled={isRunning || isGeneratingAnyCourse}
                      className="course-action-button course-action-outback px-3 py-2 text-xs disabled:cursor-not-allowed"
                    >
                      {isGeneratingAutoLoop ? "왕복 코스 찾는 중..." : "왕복 코스 찾기"}
                    </button>

                    <button
                      type="button"
                      onClick={handleGenerateOneWayCandidates}
                      disabled={isRunning || isGeneratingAnyCourse}
                      className="course-action-button course-action-oneway px-3 py-2 text-xs disabled:cursor-not-allowed"
                    >
                      {isGeneratingOneWay ? "편도 코스 찾는 중..." : "편도 코스 찾기"}
                    </button>
                  </div>

                  <div className="mt-2 text-[11px] text-slate-500">
                    왕복은 편도 끝지점까지 갔다가 같은 길로 돌아옵니다. 편도는 목표 거리만큼 한 방향으로 이동하는 후보를 찾습니다.
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    onClick={handleStartCustomCourseMode}
                    disabled={isRunning}
                    className="course-action-button course-action-custom px-3 py-2 text-sm disabled:cursor-not-allowed"
                  >
                    직접 코스 만들기
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
        <div
          className={`race-panel race-auto-loop-panel ${
            isAutoLoopPanelCollapsed ? "race-auto-loop-panel-collapsed" : ""
          }`}
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-bold text-slate-900">
                {candidateModeLabel} 후보
              </div>
              <div className="text-xs text-slate-500">{status}</div>
              {isAutoLoopPanelCollapsed && previewingAutoLoopCandidate && (
                <div className="mt-1 text-[11px] font-semibold text-blue-700">
                  미리보기: {previewingAutoLoopCandidate.name} ·{" "}
                  {(previewingAutoLoopCandidate.distanceM / 1000).toFixed(2)}km
                </div>
              )}
            </div>

            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={() => setIsAutoLoopPanelCollapsed((value) => !value)}
                className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
              >
                {isAutoLoopPanelCollapsed ? "열기" : "접기"}
              </button>

              <button
                type="button"
                onClick={handleCloseAutoLoopPanel}
                className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
              >
                닫기
              </button>
            </div>
          </div>

          {!isAutoLoopPanelCollapsed && (
            <>
              {isGeneratingAnyCourse && (
                <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                  현재 위치와 주변 보행 경로를 기준으로 {candidateModeLabel} 후보를 탐색 중입니다.
                </div>
              )}

              {autoLoopError && (
                <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
                  {autoLoopError}
                </div>
              )}

              {autoLoopCandidates.length > 0 && (
                <div className="space-y-2">
                  <div className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
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
                        className={`rounded-lg border p-2 ${
                          isPreviewing
                            ? "border-blue-300 bg-blue-50"
                            : candidate.isWithinTolerance
                              ? "border-emerald-200 bg-white"
                              : "border-yellow-200 bg-yellow-50"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                              <span
                                className="inline-block h-3 w-3 rounded-full"
                                style={{
                                  backgroundColor: getAutoLoopCandidateColor(index),
                                }}
                              />
                              {candidate.name}
                              {isPreviewing && (
                                <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white">
                                  미리보기 중
                                </span>
                              )}
                            </div>

                            <div className="mt-1 text-xs text-slate-600">
                              거리 {(candidate.distanceM / 1000).toFixed(2)}km · 오차{" "}
                              {(candidate.distanceErrorM / 1000).toFixed(2)}km
                            </div>

                            {candidateMode === "outAndBack" && (
                              <div className="text-[11px] text-orange-700">
                                편도 끝 반환점: {formatPoint(candidate.endpoint)}
                              </div>
                            )}

                            <div className="text-[11px] text-slate-500">
                              {candidate.isWithinTolerance
                                ? "허용 오차 ±0.5km 안"
                                : "허용 오차 밖"}
                            </div>

                            <div className="mt-1 text-[11px] font-medium text-slate-700">
                              {formatElevationSummary(summary)}
                            </div>
                          </div>

                          <div className="flex shrink-0 flex-col gap-1">
                            <button
                              type="button"
                              onClick={() => handlePreviewAutoLoopCandidate(candidate, index)}
                              className={`rounded-lg px-3 py-2 text-xs font-semibold ${
                                isPreviewing
                                  ? "bg-blue-100 text-blue-700"
                                  : "bg-slate-100 text-slate-700"
                              }`}
                            >
                              지도에서 보기
                            </button>

                            <button
                              type="button"
                              onClick={() => handleApplyAutoLoopCandidate(candidate)}
                              className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white"
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
                      className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      후보 다시 찾기
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setActivePanel("setup");
                        setSetupView("main");
                      }}
                      className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700"
                    >
                      설정으로
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activePanel === "map" && isCustomCourseMode && (
        <div className="race-panel race-custom-panel">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-bold text-slate-900">
                커스텀 코스 생성
              </div>
              <div className="text-xs text-slate-500">
                다음 선택: {getCustomStepLabel(customPointStep)}
              </div>
            </div>

            <button
              type="button"
              onClick={handleCancelCustomCourseMode}
              className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
            >
              취소
            </button>
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
            {(["start", "turnaround", "finish"] as CustomPointStep[]).map(
              (pointType) => {
                const point = customPoints[pointType];

                return (
                  <div
                    key={pointType}
                    className="flex items-center justify-between gap-2"
                  >
                    <div>
                      <span className="font-semibold">
                        {getCustomPointLabel(pointType)}:
                      </span>{" "}
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
              }
            )}
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

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleAddTurnaroundPoint}
              disabled={!customPoints.start || Boolean(customPoints.finish)}
              className="rounded-lg bg-orange-600 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              반환점 추가
            </button>

            <button
              type="button"
              onClick={handleUseStartAsFinish}
              disabled={!customPoints.start || !customPoints.turnaround}
              className="rounded-lg bg-slate-700 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              종료=시작
            </button>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
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
            지도에서 시작점과 종료지점을 선택하세요. 반환점을 추가하면 왕복 또는 경유
            코스로 만들 수 있습니다. 저장 옵션을 켜면 나의 코스에서 다시 불러올 수
            있습니다.
          </div>
        </div>
      )}

      {activePanel === "map" && !isAutoLoopPanelVisible && !isCustomCourseMode && (        <div
          className={`race-panel race-map-hud ${
            isLeaderboardOpen ? "race-map-hud-open" : "race-map-hud-collapsed"
          }`}
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-bold text-slate-900">
                {isRunning ? "Race Running" : "Map View"}
              </div>
              <div className="text-xs text-slate-500">{status}</div>
            </div>

            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={() => setIsLeaderboardOpen((value) => !value)}
                className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
              >
                {isLeaderboardOpen ? "접기" : "열기"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setActivePanel("setup");
                  setSetupView("main");
                }}
                className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
              >
                설정
              </button>
            </div>
          </div>

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

          {isLeaderboardOpen && (
            <>
              <div className="mt-2 text-xs text-slate-500">
                Course: {activeCourse.name} · length:{" "}
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
                      {(runner.distanceM / 1000).toFixed(2)} km ·{" "}
                      {runner.progressPercent.toFixed(1)}%
                      {runner.finished ? " · Finished" : ""}
                    </div>

                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${
                          runner.type === "player"
                            ? "bg-green-600"
                            : "bg-blue-600"
                        }`}
                        style={{
                          width: `${Math.min(runner.progressPercent, 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

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

      <style jsx global>{`
        html,
        body {
          margin: 0;
          padding: 0;
          background: #f8fafc;
        }

        .race-root {
          position: fixed;
          inset: 0;
          width: 100vw;
          height: 100vh;
          height: 100dvh;
          overflow: hidden;
          background: #f8fafc;
        }

        .setup-background {
          position: absolute;
          inset: 0;
          z-index: 20;
          overflow: hidden;
          background-image: url("/backgrounds/runner-bg.jpg");
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
          border: 0;
          border-radius: 14px;
          padding: 10px 12px;
          background: rgba(255, 255, 255, 0.95);
          color: #334155;
          font-size: 14px;
          font-weight: 800;
          box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
        }

        .race-tab-active {
          background: #0f172a;
          color: white;
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
        }

        .race-map-hud,
        .race-custom-panel,
        .race-auto-loop-panel {
          left: 10px;
          right: 10px;
          bottom: max(10px, env(safe-area-inset-bottom));
          overflow-y: auto;
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.96);
          padding: 12px;
          box-shadow: 0 18px 48px rgba(15, 23, 42, 0.26);
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
          border: 0;
          border-radius: 9999px;
          background: rgba(37, 99, 235, 0.96);
          color: white;
          padding: 10px 14px;
          font-size: 13px;
          font-weight: 900;
          box-shadow: 0 10px 28px rgba(15, 23, 42, 0.22);
        }

        .map-location-button:disabled {
          cursor: not-allowed;
          background: rgba(148, 163, 184, 0.9);
        }

        .map-location-meta {
          border-radius: 9999px;
          background: rgba(255, 255, 255, 0.94);
          color: #334155;
          padding: 4px 8px;
          font-size: 10px;
          font-weight: 700;
          box-shadow: 0 6px 18px rgba(15, 23, 42, 0.14);
        }

        .map-location-meta-error {
          color: #b91c1c;
          background: rgba(254, 242, 242, 0.96);
        }

        .run-settings-backdrop {
          position: absolute;
          inset: 0;
          z-index: 70;
          display: flex;
          align-items: flex-end;
          justify-content: center;
          background: rgba(15, 23, 42, 0.36);
          padding: 12px 10px max(10px, env(safe-area-inset-bottom)) 10px;
        }

        .run-settings-panel {
          width: 100%;
          max-width: 560px;
          max-height: min(84vh, 680px);
          overflow-y: auto;
          border-radius: 24px 24px 18px 18px;
          background: rgba(255, 255, 255, 0.98);
          padding: 14px;
          box-shadow: 0 24px 70px rgba(15, 23, 42, 0.34);
          -webkit-overflow-scrolling: touch;
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
          background: rgba(15, 23, 42, 0.94);
          color: white;
          padding: 12px 14px;
          box-shadow: 0 18px 48px rgba(15, 23, 42, 0.3);
        }

        .custom-guide-text {
          font-size: 14px;
          font-weight: 800;
          line-height: 1.35;
        }

        .custom-guide-close {
          border: 0;
          border-radius: 9999px;
          width: 28px;
          height: 28px;
          background: rgba(255, 255, 255, 0.14);
          color: white;
          font-size: 20px;
          line-height: 1;
          font-weight: 800;
        }



        /* iOS Weather-style glass treatment for the setup screen */
        .race-setup-panel > div {
          position: relative;
          z-index: 2;
        }

        .hero-glass-card {
          border-color: rgba(255, 255, 255, 0.34) !important;
          background:
            linear-gradient(
              135deg,
              rgba(15, 23, 42, 0.62),
              rgba(15, 23, 42, 0.36)
            ) !important;
          backdrop-filter: blur(24px) saturate(145%);
          -webkit-backdrop-filter: blur(24px) saturate(145%);
          box-shadow:
            0 24px 60px rgba(15, 23, 42, 0.26),
            inset 0 1px 0 rgba(255, 255, 255, 0.18),
            inset 0 -1px 0 rgba(255, 255, 255, 0.06);
        }

        .race-setup-panel .rounded-xl.border,
        .race-setup-panel .rounded-lg.border {
          border-color: rgba(255, 255, 255, 0.34) !important;
          background: rgba(255, 255, 255, 0.18) !important;
          backdrop-filter: blur(22px) saturate(145%);
          -webkit-backdrop-filter: blur(22px) saturate(145%);
          box-shadow:
            0 18px 46px rgba(15, 23, 42, 0.18),
            inset 0 1px 0 rgba(255, 255, 255, 0.42),
            inset 0 -1px 0 rgba(255, 255, 255, 0.12);
        }

        .race-setup-panel .bg-white {
          background: rgba(255, 255, 255, 0.20) !important;
          backdrop-filter: blur(18px) saturate(138%);
          -webkit-backdrop-filter: blur(18px) saturate(138%);
        }

        .race-setup-panel .bg-slate-50,
        .race-setup-panel .bg-blue-50,
        .race-setup-panel .bg-orange-50,
        .race-setup-panel .bg-red-50,
        .race-setup-panel .bg-yellow-50,
        .race-setup-panel .bg-emerald-50 {
          background: rgba(255, 255, 255, 0.14) !important;
          backdrop-filter: blur(16px) saturate(132%);
          -webkit-backdrop-filter: blur(16px) saturate(132%);
        }

        .race-setup-panel input {
          border-color: rgba(255, 255, 255, 0.42) !important;
          background: rgba(255, 255, 255, 0.24) !important;
          color: #0f172a;
          backdrop-filter: blur(14px) saturate(128%);
          -webkit-backdrop-filter: blur(14px) saturate(128%);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.36),
            0 8px 20px rgba(15, 23, 42, 0.06);
        }

        .race-setup-panel input::placeholder {
          color: rgba(51, 65, 85, 0.68);
        }


        .course-action-button {
          position: relative;
          overflow: hidden;
          width: 100%;
          min-height: 42px;
          border: 1px solid rgba(255, 255, 255, 0.38);
          border-radius: 16px;
          color: rgba(255, 255, 255, 0.98);
          font-weight: 900;
          letter-spacing: -0.01em;
          text-shadow: 0 1px 1px rgba(15, 23, 42, 0.18);
          backdrop-filter: blur(18px) saturate(145%);
          -webkit-backdrop-filter: blur(18px) saturate(145%);
          box-shadow:
            0 12px 28px rgba(15, 23, 42, 0.20),
            inset 0 1px 0 rgba(255, 255, 255, 0.32),
            inset 0 -1px 0 rgba(15, 23, 42, 0.12);
          transition:
            transform 140ms ease,
            filter 140ms ease,
            box-shadow 140ms ease,
            border-color 140ms ease,
            background 140ms ease;
        }

        .course-action-button::before {
          content: "";
          position: absolute;
          inset: 0;
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.24),
              rgba(255, 255, 255, 0.06) 42%,
              transparent 72%
            );
          pointer-events: none;
        }

        .course-action-button:hover:not(:disabled) {
          filter: brightness(1.04) saturate(1.04);
          border-color: rgba(255, 255, 255, 0.52);
          box-shadow:
            0 16px 34px rgba(15, 23, 42, 0.24),
            inset 0 1px 0 rgba(255, 255, 255, 0.38),
            inset 0 -1px 0 rgba(15, 23, 42, 0.14);
        }

        .course-action-button:active:not(:disabled) {
          transform: translateY(1px) scale(0.982);
          filter: brightness(0.96) saturate(0.98);
          box-shadow:
            0 7px 18px rgba(15, 23, 42, 0.24),
            inset 0 2px 10px rgba(15, 23, 42, 0.18),
            inset 0 1px 0 rgba(255, 255, 255, 0.20);
        }

        .course-action-button:disabled {
          border-color: rgba(255, 255, 255, 0.22);
          background: rgba(203, 213, 225, 0.38) !important;
          color: rgba(255, 255, 255, 0.66);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.18),
            0 8px 20px rgba(15, 23, 42, 0.08);
          text-shadow: none;
        }

        .course-action-outback {
          background:
            linear-gradient(
              135deg,
              rgba(16, 185, 129, 0.84),
              rgba(5, 150, 105, 0.66)
            );
        }

        .course-action-oneway {
          background:
            linear-gradient(
              135deg,
              rgba(99, 102, 241, 0.86),
              rgba(79, 70, 229, 0.66)
            );
        }

        .course-action-custom {
          background:
            linear-gradient(
              135deg,
              rgba(37, 99, 235, 0.80),
              rgba(29, 78, 216, 0.58)
            );
        }

        .race-root button {
          transform: translateY(0) scale(1);
          transition:
            transform 140ms ease,
            box-shadow 140ms ease,
            filter 140ms ease,
            background-color 140ms ease,
            border-color 140ms ease;
          will-change: transform;
        }

        .race-root button:hover:not(:disabled) {
          filter: brightness(1.02);
        }

        .race-root button:active:not(:disabled) {
          transform: translateY(1px) scale(0.975);
          filter: brightness(0.96);
        }

        .race-root button:disabled {
          transform: none;
          filter: none;
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
      `}</style>
    </div>
  );
}