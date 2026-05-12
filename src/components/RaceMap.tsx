"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { HAN_RIVER_YEOUIDO_5K } from "@/lib/courses/hanRiver";
import {
  generateCustomWalkingCourse,
  generateLocalOutAndBackCourse,
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

type SavedCourseRecord = Course & {
  savedId: string;
  favorite: boolean;
  order: number;
  createdAt: number;
  updatedAt: number;
};

const INITIAL_SELECTED_BOT_IDS = ["bot_600", "bot_500", "bot_400"];
const SAVED_COURSES_STORAGE_KEY = "runbot:savedCourses:v1";

const DEFAULT_COURSE: Course = {
  id: HAN_RIVER_YEOUIDO_5K.id,
  name: HAN_RIVER_YEOUIDO_5K.name,
  distanceM: HAN_RIVER_YEOUIDO_5K.distanceM,
  polyline: HAN_RIVER_YEOUIDO_5K.polyline,
};

const INITIAL_CUSTOM_POINTS: CustomCoursePoints = {
  start: null,
  turnaround: null,
  finish: null,
};

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
  if (guide === "select-start") {
    return "지도를 눌러 시작점을 선택하십시오.";
  }

  if (guide === "add-turnaround") {
    return "반환점을 추가하려면 반환점 추가 버튼을 누르십시오.";
  }

  if (guide === "select-turnaround") {
    return "지도를 눌러 반환점을 선택하십시오.";
  }

  if (guide === "select-finish") {
    return "지도를 눌러 종료 지점을 선택하십시오.";
  }

  if (guide === "build-course") {
    return "코스 생성 버튼을 눌러 코스를 생성하십시오.";
  }

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

function getSortedSavedCourses(courses: SavedCourseRecord[]): SavedCourseRecord[] {
  return [...courses].sort((a, b) => {
    if (a.favorite !== b.favorite) {
      return a.favorite ? -1 : 1;
    }

    if (a.order !== b.order) {
      return a.order - b.order;
    }

    return b.createdAt - a.createdAt;
  });
}

function validateSavedCourseRecord(value: unknown): SavedCourseRecord | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Partial<SavedCourseRecord>;

  if (
    typeof record.savedId !== "string" ||
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.distanceM !== "number" ||
    !Array.isArray(record.polyline)
  ) {
    return null;
  }

  const validPolyline = record.polyline.every((point) => {
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

  return {
    savedId: record.savedId,
    id: record.id,
    name: record.name,
    distanceM: record.distanceM,
    polyline: record.polyline as LngLat[],
    favorite: Boolean(record.favorite),
    order: typeof record.order === "number" ? record.order : 0,
    createdAt:
      typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    updatedAt:
      typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  };
}

export default function RaceMap() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  const startMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const finishMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const playerMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const botMarkerRefs = useRef<Record<string, mapboxgl.Marker>>({});
  const customPointMarkerRefs = useRef<
    Partial<Record<CustomPointStep, mapboxgl.Marker>>
  >({});

  const animationFrameRef = useRef<number | null>(null);
  const lastHudUpdateRef = useRef<number>(0);
  const latestGpsProjectionRef = useRef<LatestGpsProjection | null>(null);

  const [activePanel, setActivePanel] = useState<ActivePanel>("setup");
  const [setupView, setSetupView] = useState<SetupView>("main");
  const [isLeaderboardOpen, setIsLeaderboardOpen] = useState(true);

  const [activeCourse, setActiveCourse] = useState<Course>(DEFAULT_COURSE);
  const [savedCourses, setSavedCourses] = useState<SavedCourseRecord[]>([]);
  const [hasLoadedSavedCourses, setHasLoadedSavedCourses] = useState(false);

  const [status, setStatus] = useState("지도 초기화 중...");
  const [error, setError] = useState<string | null>(null);
  const [gpsActionError, setGpsActionError] = useState<string | null>(null);

  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [isGeneratingCourse, setIsGeneratingCourse] = useState(false);
  const [isGeneratingCustomCourse, setIsGeneratingCustomCourse] =
    useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [startTimeMs, setStartTimeMs] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const [playerName, setPlayerName] = useState("Me");
  const [paceInput, setPaceInput] = useState("5:30");
  const [playerMode, setPlayerMode] = useState<PlayerMode>("pace");

  const [selectedBotIds, setSelectedBotIds] = useState<string[]>(
    INITIAL_SELECTED_BOT_IDS
  );

  const [isCustomCourseMode, setIsCustomCourseMode] = useState(false);
  const [customPointStep, setCustomPointStep] =
    useState<CustomPointStep>("start");
  const [customGuide, setCustomGuide] =
    useState<CustomGuide>(null);
  const [customPoints, setCustomPoints] =
    useState<CustomCoursePoints>(INITIAL_CUSTOM_POINTS);
  const [customCourseError, setCustomCourseError] = useState<string | null>(
    null
  );
  const [isOneTimeCustomCourse, setIsOneTimeCustomCourse] = useState(true);
  const [customCourseName, setCustomCourseName] = useState("");

  const [runnerHud, setRunnerHud] = useState<RunnerHudState[]>([]);
  const [isSecureContextState, setIsSecureContextState] = useState<
    boolean | null
  >(null);

  const gpsTracker = useGpsTracker(activeCourse.polyline);

  const courseLengthM = useMemo(() => {
    return getPolylineLengthM(activeCourse.polyline);
  }, [activeCourse]);

  const playerPaceSecPerKm = useMemo(() => {
    return parsePaceInput(paceInput);
  }, [paceInput]);

  const selectedBots = useMemo(() => {
    return DEFAULT_BOTS.filter((bot) => selectedBotIds.includes(bot.id));
  }, [selectedBotIds]);

  const sortedSavedCourses = useMemo(() => {
    return getSortedSavedCourses(savedCourses);
  }, [savedCourses]);

  const canBuildCustomCourse =
    Boolean(customPoints.start) &&
    Boolean(customPoints.finish) &&
    !isGeneratingCustomCourse;

  function createInitialHud(): RunnerHudState[] {
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

  function fitMapToCourse(course: Course) {
    const map = mapRef.current;
    if (!map || course.polyline.length === 0) return;

    const bounds = new mapboxgl.LngLatBounds();
    course.polyline.forEach((coord) => bounds.extend(coord));

    map.fitBounds(bounds, {
      padding: 80,
      duration: 800,
    });
  }

  function updateCourseSource(course: Course) {
    const map = mapRef.current;
    if (!map) return;

    const data = makeCourseGeoJson(course);

    const source = map.getSource("race-course") as
      | mapboxgl.GeoJSONSource
      | undefined;

    if (source) {
      source.setData(data as GeoJSON.Feature<GeoJSON.LineString>);
      return;
    }

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

  function resetMarkersToCourseStart(course: Course) {
    const start = course.polyline[0];
    const finish = course.polyline[course.polyline.length - 1];

    if (!start || !finish) return;

    startMarkerRef.current?.setLngLat(start);
    finishMarkerRef.current?.setLngLat(finish);
    playerMarkerRef.current?.setLngLat(start);

    DEFAULT_BOTS.forEach((bot) => {
      const marker = botMarkerRefs.current[bot.id];
      if (marker) {
        marker.setLngLat(start);
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
    setStatus("커스텀 코스 지점을 초기화했습니다.");
  }

  function saveCustomCourse(course: Course) {
    const now = Date.now();
    const minOrder = savedCourses.reduce(
      (min, item) => Math.min(min, item.order),
      0
    );

    const record: SavedCourseRecord = {
      ...course,
      savedId: `saved-course-${now}`,
      favorite: false,
      order: minOrder - 1,
      createdAt: now,
      updatedAt: now,
    };

    setSavedCourses((current) => [record, ...current]);
  }

  function applySavedCourse(course: SavedCourseRecord) {
    const nextCourse: Course = {
      id: course.id,
      name: course.name,
      distanceM: course.distanceM,
      polyline: course.polyline,
    };

    gpsTracker.stop();
    latestGpsProjectionRef.current = null;
    clearCustomPointMarkers();

    setIsCustomCourseMode(false);
    setActiveCourse(nextCourse);
    setActivePanel("map");
    setSetupView("main");
    setStatus(`${course.name} 코스를 적용했습니다.`);
  }

  function toggleSavedCourseFavorite(savedId: string) {
    setSavedCourses((current) =>
      current.map((course) =>
        course.savedId === savedId
          ? {
              ...course,
              favorite: !course.favorite,
              updatedAt: Date.now(),
            }
          : course
      )
    );
  }

  function canMoveSavedCourse(savedId: string, direction: "up" | "down") {
    const index = sortedSavedCourses.findIndex(
      (course) => course.savedId === savedId
    );
    const targetIndex = direction === "up" ? index - 1 : index + 1;

    if (index < 0 || targetIndex < 0 || targetIndex >= sortedSavedCourses.length) {
      return false;
    }

    return (
      sortedSavedCourses[index].favorite ===
      sortedSavedCourses[targetIndex].favorite
    );
  }

  function moveSavedCourse(savedId: string, direction: "up" | "down") {
    if (!canMoveSavedCourse(savedId, direction)) return;

    const index = sortedSavedCourses.findIndex(
      (course) => course.savedId === savedId
    );
    const targetIndex = direction === "up" ? index - 1 : index + 1;

    const source = sortedSavedCourses[index];
    const target = sortedSavedCourses[targetIndex];

    setSavedCourses((current) =>
      current.map((course) => {
        if (course.savedId === source.savedId) {
          return {
            ...course,
            order: target.order,
            updatedAt: Date.now(),
          };
        }

        if (course.savedId === target.savedId) {
          return {
            ...course,
            order: source.order,
            updatedAt: Date.now(),
          };
        }

        return course;
      })
    );
  }

  function deleteSavedCourse(savedId: string) {
    const target = savedCourses.find((course) => course.savedId === savedId);

    if (target && !window.confirm(`"${target.name}" 코스를 삭제할까요?`)) {
      return;
    }

    setSavedCourses((current) =>
      current.filter((course) => course.savedId !== savedId)
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

  useEffect(() => {
    setIsSecureContextState(
      typeof window !== "undefined" ? window.isSecureContext : null
    );
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SAVED_COURSES_STORAGE_KEY);

      if (!raw) {
        setSavedCourses([]);
        return;
      }

      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        setSavedCourses([]);
        return;
      }

      setSavedCourses(
        parsed
          .map(validateSavedCourseRecord)
          .filter((course): course is SavedCourseRecord => Boolean(course))
      );
    } catch (error) {
      console.warn("Failed to load saved courses:", error);
      setSavedCourses([]);
    } finally {
      setHasLoadedSavedCourses(true);
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedSavedCourses) return;

    window.localStorage.setItem(
      SAVED_COURSES_STORAGE_KEY,
      JSON.stringify(savedCourses)
    );
  }, [savedCourses, hasLoadedSavedCourses]);

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
      center: [126.9205, 37.5297],
      zoom: 13.5,
      pitch: 0,
      bearing: 0,
    });

    mapRef.current = map;

    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    map.on("load", () => {
      setStatus("지도 로딩 완료");
      setIsMapLoaded(true);

      updateCourseSource(DEFAULT_COURSE);

      const start = DEFAULT_COURSE.polyline[0];
      const finish = DEFAULT_COURSE.polyline[DEFAULT_COURSE.polyline.length - 1];

      startMarkerRef.current = new mapboxgl.Marker({ color: "#16a34a" })
        .setLngLat(start)
        .setPopup(new mapboxgl.Popup().setText("Start"))
        .addTo(map);

      finishMarkerRef.current = new mapboxgl.Marker({ color: "#dc2626" })
        .setLngLat(finish)
        .setPopup(new mapboxgl.Popup().setText("Finish"))
        .addTo(map);

      playerMarkerRef.current = new mapboxgl.Marker({
        element: createRunnerMarkerElement("You", "🏃", "#16a34a"),
        anchor: "bottom",
      })
        .setLngLat(start)
        .setPopup(new mapboxgl.Popup().setText("You"))
        .addTo(map);

      DEFAULT_BOTS.forEach((bot) => {
        const marker = new mapboxgl.Marker({
          element: createRunnerMarkerElement(bot.name, "🤖", "#2563eb"),
          anchor: "bottom",
        })
          .setLngLat(start)
          .setPopup(
            new mapboxgl.Popup().setText(
              `${bot.name} · ${formatPace(bot.paceSecPerKm)}`
            )
          )
          .addTo(map);

        marker.getElement().style.display = selectedBotIds.includes(bot.id)
          ? "flex"
          : "none";

        botMarkerRefs.current[bot.id] = marker;
      });

      fitMapToCourse(DEFAULT_COURSE);
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

      gpsTracker.stop();
      clearCustomPointMarkers();

      startMarkerRef.current?.remove();
      startMarkerRef.current = null;

      finishMarkerRef.current?.remove();
      finishMarkerRef.current = null;

      playerMarkerRef.current?.remove();
      playerMarkerRef.current = null;

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

    updateCourseSource(activeCourse);
    resetMarkersToCourseStart(activeCourse);
    fitMapToCourse(activeCourse);

    setRunnerHud(createInitialHud());
    setElapsedSec(0);
    setStartTimeMs(null);
    latestGpsProjectionRef.current = null;

    // activeCourse 변경 시 지도와 HUD를 확정 동기화
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCourse, isMapLoaded]);

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
  }, [activePanel, isLeaderboardOpen]);

  useEffect(() => {
    Object.entries(botMarkerRefs.current).forEach(([botId, marker]) => {
      marker.getElement().style.display = selectedBotIds.includes(botId)
        ? "flex"
        : "none";
    });

    if (!isRunning) {
      setRunnerHud(createInitialHud());
    }

    // 봇 선택 변경 시 HUD와 marker 표시만 동기화
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBotIds, isRunning]);

  useEffect(() => {
    if (!isRunning || startTimeMs === null) return;

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
        setStatus("레이스 종료");
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

  async function handleGenerateCourseFromCurrentLocation() {
    if (isRunning) return;

    setGpsActionError(null);
    setCustomCourseError(null);

    if (isSecureContextState === false) {
      setGpsActionError("현재 위치 기준 코스 생성은 HTTPS 환경에서 테스트해야 합니다.");
      return;
    }

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

    if (!token) {
      setGpsActionError("Mapbox token이 없습니다.");
      return;
    }

    try {
      setIsGeneratingCourse(true);
      setStatus("현재 위치를 가져오는 중...");

      const position = await getCurrentPosition();

      const accuracy = position.coords.accuracy;

      if (accuracy > 120) {
        setGpsActionError(
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

      playerMarkerRef.current?.setLngLat(origin);
      mapRef.current?.flyTo({
        center: origin,
        zoom: 16,
        duration: 600,
      });

      setStatus("현재 위치 기준 코스를 생성하는 중...");

      const nextCourse = await generateLocalOutAndBackCourse({
        origin,
        token,
        targetDistanceM: 1000,
      });

      gpsTracker.stop();
      latestGpsProjectionRef.current = null;
      clearCustomPointMarkers();

      setIsCustomCourseMode(false);
      setCustomGuide(null);
      setCustomPoints(INITIAL_CUSTOM_POINTS);
      setPlayerMode("gps");
      setActiveCourse(nextCourse);
      setActivePanel("map");
      setSetupView("main");
      setGpsActionError(null);
      setStatus(
        `현재 위치 기준 코스 생성 완료 · ${(nextCourse.distanceM / 1000).toFixed(
          2
        )}km`
      );
    } catch (rawError) {
      const message = getPositionErrorMessage(rawError);

      setGpsActionError(message);
      setStatus("현재 위치 기준 코스 생성 실패");
    } finally {
      setIsGeneratingCourse(false);
    }
  }

  function handleStartCustomCourseMode() {
    if (isRunning) return;

    setIsCustomCourseMode(true);
    setCustomPointStep("start");
    setCustomGuide("select-start");
    setCustomPoints(INITIAL_CUSTOM_POINTS);
    setCustomCourseError(null);
    setIsOneTimeCustomCourse(true);
    setCustomCourseName("");
    clearCustomPointMarkers();
    setIsLeaderboardOpen(false);
    setActivePanel("map");
    setSetupView("main");
    setStatus("커스텀 코스 생성: 시작지점을 선택하세요.");
  }

  function handleCancelCustomCourseMode() {
    setIsCustomCourseMode(false);
    setCustomPointStep("start");
    setCustomGuide(null);
    setCustomPoints(INITIAL_CUSTOM_POINTS);
    setCustomCourseError(null);
    clearCustomPointMarkers();
    setStatus("커스텀 코스 생성을 취소했습니다.");
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
    const finalName = isOneTimeCustomCourse
      ? customPoints.turnaround
        ? "일회성 경유 코스"
        : "일회성 코스"
      : trimmedName || `나의 코스 ${savedCourses.length + 1}`;

    try {
      setIsGeneratingCustomCourse(true);
      setCustomCourseError(null);
      setStatus("선택한 지점 기준으로 코스를 생성하는 중...");

      const nextCourse = await generateCustomWalkingCourse({
        start: customPoints.start,
        turnaround: customPoints.turnaround,
        finish: customPoints.finish,
        token,
        name: finalName,
      });

      gpsTracker.stop();
      latestGpsProjectionRef.current = null;
      clearCustomPointMarkers();

      if (!isOneTimeCustomCourse) {
        saveCustomCourse(nextCourse);
      }

      setIsCustomCourseMode(false);
      setCustomGuide(null);
      setCustomPointStep("start");
      setCustomPoints(INITIAL_CUSTOM_POINTS);
      setActiveCourse(nextCourse);
      setActivePanel("map");
      setSetupView("main");
      setStatus(
        `${isOneTimeCustomCourse ? "일회성" : "저장"} 코스 생성 완료 · ${(
          nextCourse.distanceM / 1000
        ).toFixed(2)}km`
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

  function handleStartRace() {
    if (!isMapLoaded) return;

    if (isCustomCourseMode) {
      setStatus("커스텀 코스 생성 중에는 레이스를 시작할 수 없습니다.");
      return;
    }

    if (playerMode === "gps" && isSecureContextState === false) {
      setStatus("GPS Beta는 HTTPS 환경에서 테스트해야 합니다.");
      setActivePanel("setup");
      return;
    }

    resetMarkersToCourseStart(activeCourse);

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
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    gpsTracker.stop();
    latestGpsProjectionRef.current = null;

    resetMarkersToCourseStart(activeCourse);

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

      {activePanel === "map" && isCustomCourseMode && customGuide && (
        <div className="custom-guide-toast">
          <div className="custom-guide-text">{getCustomGuideText(customGuide)}</div>
          {customGuide === "add-turnaround" && (
            <button
              type="button"
              onClick={closeCustomGuide}
              className="custom-guide-close"
              aria-label="닫기"
            >
              ×
            </button>
          )}
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
              <div>
                <div className="text-2xl font-bold text-slate-900">
                  PaceRace
                </div>
                <div className="text-xs text-slate-500">{status}</div>
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
                  <div className="font-semibold text-slate-900">
                    {activeCourse.name}
                  </div>
                  <div>길이: {(courseLengthM / 1000).toFixed(2)} km</div>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    onClick={handleGenerateCourseFromCurrentLocation}
                    disabled={isRunning || isGeneratingCourse}
                    className="rounded-lg bg-orange-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {isGeneratingCourse
                      ? "현재 위치 코스 생성 중..."
                      : "현재 위치 기준 1K 코스 생성"}
                  </button>

                  <button
                    type="button"
                    onClick={handleStartCustomCourseMode}
                    disabled={isRunning}
                    className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    커스텀 코스 만들기
                  </button>
                </div>

                {gpsActionError && (
                  <div className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700">
                    {gpsActionError}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="mb-2 text-sm font-semibold text-slate-900">
                  플레이어 설정
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">
                      닉네임
                    </div>
                    <input
                      value={playerName}
                      onChange={(event) => setPlayerName(event.target.value)}
                      disabled={isRunning}
                      className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 disabled:bg-slate-100"
                    />
                  </label>

                  <label className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">
                      내 페이스
                    </div>
                    <input
                      value={paceInput}
                      onChange={(event) => setPaceInput(event.target.value)}
                      disabled={isRunning || playerMode === "gps"}
                      placeholder="5:30"
                      className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 disabled:bg-slate-100"
                    />
                  </label>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPlayerMode("pace")}
                    disabled={isRunning}
                    className={`rounded-lg px-3 py-2 text-sm font-semibold ${
                      playerMode === "pace"
                        ? "bg-green-600 text-white"
                        : "bg-slate-100 text-slate-700"
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    페이스 입력
                  </button>

                  <button
                    type="button"
                    onClick={() => setPlayerMode("gps")}
                    disabled={isRunning}
                    className={`rounded-lg px-3 py-2 text-sm font-semibold ${
                      playerMode === "gps"
                        ? "bg-orange-600 text-white"
                        : "bg-slate-100 text-slate-700"
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    GPS Beta
                  </button>
                </div>

                <div className="mt-3 rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
                  {playerMode === "pace" ? (
                    <>
                      입력 페이스:{" "}
                      <span className="font-semibold text-slate-900">
                        {formatPace(playerPaceSecPerKm)}
                      </span>
                    </>
                  ) : (
                    <>
                      GPS 모드:{" "}
                      <span className="font-semibold text-orange-700">
                        실제 위치 기반
                      </span>
                    </>
                  )}
                </div>
              </div>

              {playerMode === "gps" && (
                <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 text-xs text-orange-900">
                  <div className="mb-1 text-sm font-semibold">
                    GPS Beta 상태
                  </div>

                  {isGpsBlockedBySecurity && (
                    <div className="mb-2 rounded-lg bg-red-100 p-2 text-red-700">
                      현재 주소는 보안 컨텍스트가 아닙니다. 모바일 GPS
                      권한 요청은 HTTPS 배포 주소에서 테스트해야 합니다.
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    <div>상태: {getGpsStatusLabel(gpsTracker.status)}</div>
                    <div>정확도: {gpsAccuracyText}</div>
                    <div>GPS 거리: {gpsDistanceText}</div>
                    <div>코스 이탈: {gpsOffCourseText}</div>
                    <div>수락 샘플: {gpsTracker.acceptedSamples}</div>
                    <div>거부 샘플: {gpsTracker.rejectedSamples}</div>
                  </div>

                  {gpsTracker.error && (
                    <div className="mt-1 text-red-600">{gpsTracker.error}</div>
                  )}

                  {gpsTracker.lastRejectedReason && (
                    <div className="mt-1 text-red-600">
                      {gpsTracker.lastRejectedReason}
                    </div>
                  )}
                </div>
              )}

              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="mb-2 text-sm font-semibold text-slate-900">
                  봇 선택
                </div>

                <div className="space-y-1">
                  {DEFAULT_BOTS.map((bot) => {
                    const checked = selectedBotIds.includes(bot.id);

                    return (
                      <label
                        key={bot.id}
                        className={`flex cursor-pointer items-center justify-between rounded-lg border px-2 py-2 text-sm ${
                          checked
                            ? "border-blue-300 bg-blue-50"
                            : "border-slate-200 bg-white"
                        } ${isRunning ? "cursor-not-allowed opacity-60" : ""}`}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isRunning}
                            onChange={() => handleToggleBot(bot.id)}
                          />
                          <span className="font-medium text-slate-800">
                            {bot.name}
                          </span>
                        </span>

                        <span className="text-xs text-slate-500">
                          {formatPace(bot.paceSecPerKm)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleStartRace}
                  disabled={!isMapLoaded || isRunning || isGpsBlockedBySecurity}
                  className="rounded-xl bg-blue-600 px-3 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  Start Race
                </button>

                <button
                  type="button"
                  onClick={handleResetRace}
                  className="rounded-xl bg-slate-800 px-3 py-3 font-semibold text-white"
                >
                  Reset
                </button>
              </div>

              <button
                type="button"
                onClick={() => setActivePanel("map")}
                className="w-full rounded-xl bg-white px-3 py-3 text-sm font-semibold text-slate-800 shadow"
              >
                지도 보기
              </button>
            </div>
          )}
        </div>
      )}

      {activePanel === "setup" && setupView === "myCourses" && (
        <div className="race-panel race-setup-panel">
          <div className="mx-auto max-w-[560px] space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-2xl font-bold text-slate-900">
                  나의 코스
                </div>
                <div className="text-xs text-slate-500">
                  즐겨찾기 코스가 최상단에 표시됩니다.
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

            {sortedSavedCourses.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
                저장한 코스가 없습니다. 커스텀 코스를 만들 때 일회성 옵션을
                끄면 이곳에 저장됩니다.
              </div>
            ) : (
              <div className="space-y-2">
                {sortedSavedCourses.map((course) => (
                  <div
                    key={course.savedId}
                    className="rounded-xl border border-slate-200 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-slate-900">
                          {course.favorite ? "★ " : ""}
                          {course.name}
                        </div>
                        <div className="text-xs text-slate-500">
                          {(course.distanceM / 1000).toFixed(2)} km · 좌표{" "}
                          {course.polyline.length}개
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => toggleSavedCourseFavorite(course.savedId)}
                        className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                          course.favorite
                            ? "bg-yellow-100 text-yellow-800"
                            : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {course.favorite ? "즐겨찾기 해제" : "즐겨찾기"}
                      </button>
                    </div>

                    <div className="mt-3 grid grid-cols-5 gap-2">
                      <button
                        type="button"
                        onClick={() => applySavedCourse(course)}
                        className="col-span-2 rounded-lg bg-blue-600 px-2 py-2 text-xs font-semibold text-white"
                      >
                        적용
                      </button>

                      <button
                        type="button"
                        onClick={() => moveSavedCourse(course.savedId, "up")}
                        disabled={!canMoveSavedCourse(course.savedId, "up")}
                        className="rounded-lg bg-slate-100 px-2 py-2 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        위
                      </button>

                      <button
                        type="button"
                        onClick={() => moveSavedCourse(course.savedId, "down")}
                        disabled={!canMoveSavedCourse(course.savedId, "down")}
                        className="rounded-lg bg-slate-100 px-2 py-2 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        아래
                      </button>

                      <button
                        type="button"
                        onClick={() => deleteSavedCourse(course.savedId)}
                        className="rounded-lg bg-red-50 px-2 py-2 text-xs font-semibold text-red-700"
                      >
                        삭제
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
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
            <label className="flex items-center justify-between gap-3 text-xs font-semibold text-slate-700">
              <span>일회성 코스</span>
              <input
                type="checkbox"
                checked={isOneTimeCustomCourse}
                onChange={(event) => setIsOneTimeCustomCourse(event.target.checked)}
              />
            </label>

            {!isOneTimeCustomCourse && (
              <label className="mt-2 block space-y-1">
                <div className="text-xs font-medium text-slate-600">
                  코스 이름
                </div>
                <input
                  value={customCourseName}
                  onChange={(event) => setCustomCourseName(event.target.value)}
                  placeholder="예: 학교 3K 루프"
                  className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 outline-none focus:border-blue-500"
                />
              </label>
            )}
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
              {isGeneratingCustomCourse ? "생성 중..." : "코스 생성"}
            </button>
          </div>

          <div className="mt-2 text-[11px] text-slate-500">
            마커를 길게 누른 채 움직이면 위치를 조정할 수 있습니다. 저장형
            코스는 설정 탭의 나의 코스에서 다시 선택할 수 있습니다.
          </div>
        </div>
      )}

      {activePanel === "map" && !isCustomCourseMode && (
        <div
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
              onClick={handleStartRace}
              disabled={!isMapLoaded || isRunning || isGpsBlockedBySecurity}
              className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Start
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
          background:
            radial-gradient(
              circle at top left,
              rgba(59, 130, 246, 0.13),
              transparent 34%
            ),
            radial-gradient(
              circle at bottom right,
              rgba(34, 197, 94, 0.12),
              transparent 30%
            ),
            #f8fafc;
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

        .race-map-hud,
        .race-custom-panel {
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

        .race-runner-list {
          max-height: 210px;
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

          .race-setup-panel {
            top: 0;
            bottom: 0;
            left: 0;
            right: 0;
            padding: calc(max(8px, env(safe-area-inset-top)) + 54px) 16px
              max(14px, env(safe-area-inset-bottom)) 16px;
          }

          .race-map-hud,
          .race-custom-panel {
            top: calc(max(8px, env(safe-area-inset-top)) + 52px);
            bottom: 10px;
            left: 10px;
            right: auto;
            width: min(390px, 42vw);
            border-radius: 22px;
            padding: 12px;
          }

          .race-map-hud-open,
          .race-custom-panel {
            max-height: none;
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

          .race-setup-panel {
            top: 0;
            bottom: 0;
            left: 0;
            right: 0;
            padding: 84px 24px 24px 24px;
          }

          .race-map-hud,
          .race-custom-panel {
            top: 72px;
            bottom: auto;
            left: 16px;
            right: auto;
            width: 390px;
            border-radius: 24px;
            padding: 14px;
          }

          .race-map-hud-open,
          .race-custom-panel {
            max-height: calc(100dvh - 88px);
          }

          .race-map-hud-collapsed {
            max-height: 176px;
          }

          .race-runner-list {
            max-height: min(330px, calc(100dvh - 365px));
          }
        }

        @media (max-width: 390px) {
          .race-setup-panel {
            padding-left: 10px;
            padding-right: 10px;
          }

          .race-map-hud,
          .race-custom-panel {
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