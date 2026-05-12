import { haversineDistanceM, type LngLat } from "./projectToCourse";

export type GpsSample = {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
  speedMps: number | null;
};

export type GpsValidationResult = {
  accepted: boolean;
  reason?: string;
  inferredSpeedMps: number | null;
  suspiciousScore: number;
};

export const GPS_LIMITS = {
  maxAccuracyM: 35,
  maxSpeedMps: 10,
  warningSpeedMps: 7,
  minSampleIntervalSec: 0.5,
};

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function gpsSampleToLngLat(sample: GpsSample): LngLat {
  return [sample.lng, sample.lat];
}

export function getSuspiciousScoreFromSpeed(speedMps: number | null): number {
  if (speedMps === null) return 0;
  if (speedMps >= 10) return 5;
  if (speedMps >= 8) return 3;
  if (speedMps >= 7) return 2;
  if (speedMps >= 6) return 1;
  return 0;
}

export function validateGpsSample(
  sample: GpsSample,
  previousSample: GpsSample | null
): GpsValidationResult {
  if (
    !isFiniteNumber(sample.lat) ||
    !isFiniteNumber(sample.lng) ||
    !isFiniteNumber(sample.accuracy) ||
    !isFiniteNumber(sample.timestamp)
  ) {
    return {
      accepted: false,
      reason: "GPS 값이 유효하지 않습니다.",
      inferredSpeedMps: null,
      suspiciousScore: 0,
    };
  }

  if (sample.accuracy > GPS_LIMITS.maxAccuracyM) {
    return {
      accepted: false,
      reason: `GPS 정확도가 낮습니다. accuracy=${sample.accuracy.toFixed(1)}m`,
      inferredSpeedMps: null,
      suspiciousScore: 0,
    };
  }

  let inferredSpeedMps = sample.speedMps;

  if (previousSample) {
    const dtSec = (sample.timestamp - previousSample.timestamp) / 1000;

    if (dtSec < GPS_LIMITS.minSampleIntervalSec) {
      return {
        accepted: false,
        reason: "GPS 샘플 간격이 너무 짧습니다.",
        inferredSpeedMps,
        suspiciousScore: 0,
      };
    }

    const distanceM = haversineDistanceM(
      gpsSampleToLngLat(previousSample),
      gpsSampleToLngLat(sample)
    );

    const speedFromDistance = distanceM / dtSec;

    if (inferredSpeedMps === null || !Number.isFinite(inferredSpeedMps)) {
      inferredSpeedMps = speedFromDistance;
    }

    if (speedFromDistance > GPS_LIMITS.maxSpeedMps) {
      return {
        accepted: false,
        reason: `GPS 위치가 비정상적으로 튀었습니다. speed=${speedFromDistance.toFixed(
          2
        )}m/s`,
        inferredSpeedMps: speedFromDistance,
        suspiciousScore: 5,
      };
    }
  }

  if (inferredSpeedMps !== null && inferredSpeedMps > GPS_LIMITS.maxSpeedMps) {
    return {
      accepted: false,
      reason: `인간 한계속도를 초과한 GPS 속도입니다. speed=${inferredSpeedMps.toFixed(
        2
      )}m/s`,
      inferredSpeedMps,
      suspiciousScore: 5,
    };
  }

  return {
    accepted: true,
    inferredSpeedMps,
    suspiciousScore: getSuspiciousScoreFromSpeed(inferredSpeedMps),
  };
}