"use client";

import { useCallback, useRef, useState } from "react";
import {
  GPS_LIMITS,
  gpsSampleToLngLat,
  type GpsSample,
  validateGpsSample,
} from "./filterGpsSample";
import {
  projectPointToCourse,
  type CourseProjection,
  type LngLat,
} from "./projectToCourse";

export type GpsTrackerStatus =
  | "idle"
  | "requesting"
  | "watching"
  | "error"
  | "unsupported";

export type LatestGpsProjection = CourseProjection & {
  raceDistanceM: number;
  speedMps: number | null;
  currentPaceSecPerKm: number | null;
  rawSample: GpsSample;
};

export type GpsTrackerState = {
  status: GpsTrackerStatus;
  error: string | null;
  latestSample: GpsSample | null;
  latestProjection: LatestGpsProjection | null;
  acceptedSamples: number;
  rejectedSamples: number;
  lastRejectedReason: string | null;
  suspiciousScore: number;
  isOffCourse: boolean;
};

const INITIAL_STATE: GpsTrackerState = {
  status: "idle",
  error: null,
  latestSample: null,
  latestProjection: null,
  acceptedSamples: 0,
  rejectedSamples: 0,
  lastRejectedReason: null,
  suspiciousScore: 0,
  isOffCourse: false,
};

function getGeolocationErrorMessage(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) {
    return "위치 권한이 거부되었습니다.";
  }

  if (error.code === error.POSITION_UNAVAILABLE) {
    return "현재 위치를 가져올 수 없습니다.";
  }

  if (error.code === error.TIMEOUT) {
    return "GPS 위치 요청 시간이 초과되었습니다.";
  }

  return error.message || "알 수 없는 GPS 오류가 발생했습니다.";
}

function speedToPaceSecPerKm(speedMps: number | null): number | null {
  if (speedMps === null || !Number.isFinite(speedMps) || speedMps <= 0.3) {
    return null;
  }

  return 1000 / speedMps;
}

export function useGpsTracker(coursePolyline: LngLat[]) {
  const watchIdRef = useRef<number | null>(null);
  const previousSampleRef = useRef<GpsSample | null>(null);
  const previousCourseDistanceMRef = useRef<number | undefined>(0);
  const startCourseDistanceMRef = useRef<number | null>(null);

  const [state, setState] = useState<GpsTrackerState>(INITIAL_STATE);

  const stop = useCallback(() => {
    if (watchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }

    watchIdRef.current = null;

    setState((current) => ({
      ...current,
      status: current.status === "unsupported" ? "unsupported" : "idle",
    }));
  }, []);

  const reset = useCallback(() => {
    if (watchIdRef.current !== null && "geolocation" in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }

    watchIdRef.current = null;
    previousSampleRef.current = null;
    previousCourseDistanceMRef.current = 0;
    startCourseDistanceMRef.current = null;

    setState(INITIAL_STATE);
  }, []);

  const start = useCallback(() => {
    if (typeof window === "undefined") return;

    if (!("geolocation" in navigator)) {
      setState({
        ...INITIAL_STATE,
        status: "unsupported",
        error: "이 브라우저는 Geolocation API를 지원하지 않습니다.",
      });
      return;
    }

    if (watchIdRef.current !== null) {
      return;
    }

    setState((current) => ({
      ...current,
      status: "requesting",
      error: null,
      lastRejectedReason: null,
    }));

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const sample: GpsSample = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
          speedMps:
            position.coords.speed !== null && Number.isFinite(position.coords.speed)
              ? position.coords.speed
              : null,
        };

        const validation = validateGpsSample(sample, previousSampleRef.current);

        if (!validation.accepted) {
          setState((current) => ({
            ...current,
            status: "watching",
            latestSample: sample,
            rejectedSamples: current.rejectedSamples + 1,
            lastRejectedReason: validation.reason ?? "GPS 샘플이 거부되었습니다.",
            suspiciousScore: current.suspiciousScore + validation.suspiciousScore,
          }));
          return;
        }

        const projection = projectPointToCourse(
          gpsSampleToLngLat(sample),
          coursePolyline,
          previousCourseDistanceMRef.current
        );

        const isOffCourse = projection.offCourseDistanceM > 60;

        if (isOffCourse) {
          setState((current) => ({
            ...current,
            status: "watching",
            latestSample: sample,
            latestProjection: {
              ...projection,
              raceDistanceM: current.latestProjection?.raceDistanceM ?? 0,
              speedMps: validation.inferredSpeedMps,
              currentPaceSecPerKm: speedToPaceSecPerKm(validation.inferredSpeedMps),
              rawSample: sample,
            },
            rejectedSamples: current.rejectedSamples + 1,
            lastRejectedReason: `코스에서 벗어났습니다. 거리=${projection.offCourseDistanceM.toFixed(
              1
            )}m`,
            suspiciousScore: current.suspiciousScore + validation.suspiciousScore,
            isOffCourse: true,
          }));
          return;
        }

        if (startCourseDistanceMRef.current === null) {
          startCourseDistanceMRef.current = projection.courseDistanceM;
        }

        const baseDistanceM = startCourseDistanceMRef.current ?? 0;
        const raceDistanceM = Math.max(0, projection.courseDistanceM - baseDistanceM);

        previousSampleRef.current = sample;
        previousCourseDistanceMRef.current = projection.courseDistanceM;

        setState((current) => ({
          ...current,
          status: "watching",
          error: null,
          latestSample: sample,
          latestProjection: {
            ...projection,
            raceDistanceM,
            speedMps: validation.inferredSpeedMps,
            currentPaceSecPerKm: speedToPaceSecPerKm(validation.inferredSpeedMps),
            rawSample: sample,
          },
          acceptedSamples: current.acceptedSamples + 1,
          lastRejectedReason: null,
          suspiciousScore: current.suspiciousScore + validation.suspiciousScore,
          isOffCourse: false,
        }));
      },
      (error) => {
        setState((current) => ({
          ...current,
          status: "error",
          error: getGeolocationErrorMessage(error),
        }));
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10_000,
      }
    );

    watchIdRef.current = watchId;
  }, [coursePolyline]);

  return {
    ...state,
    start,
    stop,
    reset,
    isWatching: state.status === "watching" || state.status === "requesting",
    limits: GPS_LIMITS,
  };
}