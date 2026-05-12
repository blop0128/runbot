"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import { HAN_RIVER_YEOUIDO_5K } from "@/lib/courses/hanRiver";
import { useGpsTracker, type LatestGpsProjection } from "@/lib/gps/useGpsTracker";
import { DEFAULT_BOTS } from "@/lib/race/bots";
import { clampPaceSecPerKm, formatPace, paceToSpeedMps } from "@/lib/race/pace";
import {
  getLngLatAtDistance,
  getPolylineLengthM,
} from "@/lib/race/interpolate";

type PlayerMode = "pace" | "gps";
type ActivePanel = "setup" | "map";

type RunnerHudState = {
  id: string;
  name: string;
  type: "player" | "bot";
  paceSecPerKm: number;
  distanceM: number;
  progressPercent: number;
  finished: boolean;
};

const INITIAL_SELECTED_BOT_IDS = ["bot_600", "bot_500", "bot_400"];

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

export default function RaceMap() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  const playerMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const botMarkerRefs = useRef<Record<string, mapboxgl.Marker>>({});

  const animationFrameRef = useRef<number | null>(null);
  const lastHudUpdateRef = useRef<number>(0);
  const latestGpsProjectionRef = useRef<LatestGpsProjection | null>(null);

  const [activePanel, setActivePanel] = useState<ActivePanel>("setup");
  const [isLeaderboardOpen, setIsLeaderboardOpen] = useState(true);

  const [status, setStatus] = useState("지도 초기화 중...");
  const [error, setError] = useState<string | null>(null);

  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [startTimeMs, setStartTimeMs] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const [playerName, setPlayerName] = useState("Me");
  const [paceInput, setPaceInput] = useState("5:30");
  const [playerMode, setPlayerMode] = useState<PlayerMode>("pace");

  const [selectedBotIds, setSelectedBotIds] = useState<string[]>(
    INITIAL_SELECTED_BOT_IDS
  );

  const [runnerHud, setRunnerHud] = useState<RunnerHudState[]>([]);
  const [isSecureContextState, setIsSecureContextState] = useState<
    boolean | null
  >(null);

  const gpsTracker = useGpsTracker(HAN_RIVER_YEOUIDO_5K.polyline);

  const courseLengthM = useMemo(() => {
    return getPolylineLengthM(HAN_RIVER_YEOUIDO_5K.polyline);
  }, []);

  const playerPaceSecPerKm = useMemo(() => {
    return parsePaceInput(paceInput);
  }, [paceInput]);

  const selectedBots = useMemo(() => {
    return DEFAULT_BOTS.filter((bot) => selectedBotIds.includes(bot.id));
  }, [selectedBotIds]);

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

  useEffect(() => {
    setIsSecureContextState(
      typeof window !== "undefined" ? window.isSecureContext : null
    );
  }, []);

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

      map.addSource("han-river-course", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: HAN_RIVER_YEOUIDO_5K.polyline,
          },
        },
      });

      map.addLayer({
        id: "han-river-course-line",
        type: "line",
        source: "han-river-course",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-width": 5,
          "line-color": "#2563eb",
        },
      });

      const start = HAN_RIVER_YEOUIDO_5K.polyline[0];
      const finish =
        HAN_RIVER_YEOUIDO_5K.polyline[
          HAN_RIVER_YEOUIDO_5K.polyline.length - 1
        ];

      new mapboxgl.Marker({ color: "#16a34a" })
        .setLngLat(start)
        .setPopup(new mapboxgl.Popup().setText("Start"))
        .addTo(map);

      new mapboxgl.Marker({ color: "#dc2626" })
        .setLngLat(finish)
        .setPopup(new mapboxgl.Popup().setText("Finish"))
        .addTo(map);

      const bounds = new mapboxgl.LngLatBounds();
      HAN_RIVER_YEOUIDO_5K.polyline.forEach((coord) => bounds.extend(coord));
      map.fitBounds(bounds, {
        padding: 80,
        duration: 800,
      });

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

      playerMarkerRef.current?.remove();
      playerMarkerRef.current = null;

      Object.values(botMarkerRefs.current).forEach((marker) => marker.remove());
      botMarkerRefs.current = {};

      map.remove();
      mapRef.current = null;
    };
    // 최초 지도 생성용 effect이므로 의존성 고정
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      let playerLngLat = getLngLatAtDistance(HAN_RIVER_YEOUIDO_5K.polyline, 0);
      let playerHudPaceSecPerKm = playerPaceSecPerKm;

      if (playerMode === "pace") {
        const playerSpeedMps = paceToSpeedMps(playerPaceSecPerKm);
        playerDistanceM = Math.min(
          playerSpeedMps * nextElapsedSec,
          courseLengthM
        );
        playerLngLat = getLngLatAtDistance(
          HAN_RIVER_YEOUIDO_5K.polyline,
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

      if (playerMarkerRef.current) {
        playerMarkerRef.current.setLngLat(playerLngLat);
      }

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
          HAN_RIVER_YEOUIDO_5K.polyline,
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
  ]);

  function resetMarkersToStart() {
    const start = HAN_RIVER_YEOUIDO_5K.polyline[0];

    playerMarkerRef.current?.setLngLat(start);

    DEFAULT_BOTS.forEach((bot) => {
      const marker = botMarkerRefs.current[bot.id];
      if (marker) {
        marker.setLngLat(start);
      }
    });
  }

  function handleToggleBot(botId: string) {
    if (isRunning) return;

    setSelectedBotIds((current) => {
      if (current.includes(botId)) {
        return current.filter((id) => id !== botId);
      }

      return [...current, botId];
    });
  }

  function handleStartRace() {
    if (!isMapLoaded) return;

    if (playerMode === "gps" && isSecureContextState === false) {
      setStatus("GPS Beta는 HTTPS 환경에서 테스트해야 합니다.");
      setActivePanel("setup");
      return;
    }

    resetMarkersToStart();

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
  }

  function handleResetRace() {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    gpsTracker.stop();
    latestGpsProjectionRef.current = null;

    resetMarkersToStart();

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
          onClick={() => setActivePanel("setup")}
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

      {activePanel === "setup" && (
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

                  <div className="mt-2 text-[11px] text-orange-800">
                    야외 테스트는 HTTPS 배포 주소에서, 코스 시작점 근처에서
                    하는 것이 가장 안정적입니다.
                  </div>
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

      {activePanel === "map" && (
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
                onClick={() => setActivePanel("setup")}
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
                Course length: {(courseLengthM / 1000).toFixed(2)} km
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

        .race-map-hud {
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

        .race-runner-list {
          max-height: 210px;
        }

        @media (orientation: landscape) and (max-height: 560px) {
          .race-top-tabs {
            left: 10px;
            right: auto;
            width: min(390px, 42vw);
            grid-template-columns: 1fr 1fr;
          }

          .race-setup-panel {
            top: 0;
            bottom: 0;
            left: 0;
            right: 0;
            padding: calc(max(8px, env(safe-area-inset-top)) + 54px) 16px
              max(14px, env(safe-area-inset-bottom)) 16px;
          }

          .race-map-hud {
            top: calc(max(8px, env(safe-area-inset-top)) + 52px);
            bottom: 10px;
            left: 10px;
            right: auto;
            width: min(390px, 42vw);
            border-radius: 22px;
            padding: 12px;
          }

          .race-map-hud-open {
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

          .race-setup-panel {
            top: 0;
            bottom: 0;
            left: 0;
            right: 0;
            padding: 84px 24px 24px 24px;
          }

          .race-map-hud {
            top: 72px;
            bottom: auto;
            left: 16px;
            right: auto;
            width: 390px;
            border-radius: 24px;
            padding: 14px;
          }

          .race-map-hud-open {
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

          .race-map-hud {
            left: 8px;
            right: 8px;
            padding: 10px;
          }

          .race-tab-button {
            padding: 9px 10px;
            font-size: 13px;
          }
        }
      `}</style>
    </div>
  );
}