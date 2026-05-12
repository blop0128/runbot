export type LngLat = [number, number];

export type CourseProjection = {
  snappedLngLat: LngLat;
  courseDistanceM: number;
  offCourseDistanceM: number;
  segmentIndex: number;
};

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function haversineDistanceM(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;

  const R = 6371000;

  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

function toLocalMeters(point: LngLat, origin: LngLat): [number, number] {
  const [lng, lat] = point;
  const [originLng, originLat] = origin;

  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLng = 111_320 * Math.cos(toRadians(originLat));

  return [
    (lng - originLng) * metersPerDegreeLng,
    (lat - originLat) * metersPerDegreeLat,
  ];
}

function fromLocalMeters(
  point: [number, number],
  origin: LngLat
): LngLat {
  const [x, y] = point;
  const [originLng, originLat] = origin;

  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLng = 111_320 * Math.cos(toRadians(originLat));

  return [
    originLng + x / metersPerDegreeLng,
    originLat + y / metersPerDegreeLat,
  ];
}

function projectPointToSegment(
  point: LngLat,
  from: LngLat,
  to: LngLat
): {
  snappedLngLat: LngLat;
  ratio: number;
  offCourseDistanceM: number;
} {
  const origin = point;

  const p = toLocalMeters(point, origin);
  const a = toLocalMeters(from, origin);
  const b = toLocalMeters(to, origin);

  const abX = b[0] - a[0];
  const abY = b[1] - a[1];

  const apX = p[0] - a[0];
  const apY = p[1] - a[1];

  const abLengthSquared = abX * abX + abY * abY;

  if (abLengthSquared === 0) {
    return {
      snappedLngLat: from,
      ratio: 0,
      offCourseDistanceM: haversineDistanceM(point, from),
    };
  }

  const ratio = clamp((apX * abX + apY * abY) / abLengthSquared, 0, 1);

  const snappedLocal: [number, number] = [
    a[0] + abX * ratio,
    a[1] + abY * ratio,
  ];

  const snappedLngLat = fromLocalMeters(snappedLocal, origin);

  return {
    snappedLngLat,
    ratio,
    offCourseDistanceM: haversineDistanceM(point, snappedLngLat),
  };
}

function getCandidateScore(
  offCourseDistanceM: number,
  courseDistanceM: number,
  previousCourseDistanceM?: number
): number {
  if (previousCourseDistanceM === undefined) {
    return offCourseDistanceM;
  }

  let score = offCourseDistanceM;

  // 왕복 코스처럼 같은 물리 경로가 반복될 때, 이전 진행거리보다 크게 뒤로 튀는 후보를 강하게 억제한다.
  const backwardToleranceM = 30;
  if (courseDistanceM < previousCourseDistanceM - backwardToleranceM) {
    score += (previousCourseDistanceM - courseDistanceM) * 5;
  }

  // GPS가 갑자기 지나치게 앞 구간으로 붙는 것도 약하게 억제한다.
  const forwardJumpToleranceM = 150;
  if (courseDistanceM > previousCourseDistanceM + forwardJumpToleranceM) {
    score += (courseDistanceM - previousCourseDistanceM - forwardJumpToleranceM) * 0.5;
  }

  return score;
}

export function projectPointToCourse(
  point: LngLat,
  polyline: LngLat[],
  previousCourseDistanceM?: number
): CourseProjection {
  if (polyline.length === 0) {
    throw new Error("Polyline is empty.");
  }

  if (polyline.length === 1) {
    return {
      snappedLngLat: polyline[0],
      courseDistanceM: 0,
      offCourseDistanceM: haversineDistanceM(point, polyline[0]),
      segmentIndex: 0,
    };
  }

  let best: CourseProjection | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let cumulativeDistanceM = 0;

  for (let i = 1; i < polyline.length; i += 1) {
    const from = polyline[i - 1];
    const to = polyline[i];

    const segmentLengthM = haversineDistanceM(from, to);
    const projected = projectPointToSegment(point, from, to);

    const courseDistanceM =
      cumulativeDistanceM + segmentLengthM * projected.ratio;

    const score = getCandidateScore(
      projected.offCourseDistanceM,
      courseDistanceM,
      previousCourseDistanceM
    );

    if (score < bestScore) {
      bestScore = score;

      best = {
        snappedLngLat: projected.snappedLngLat,
        courseDistanceM,
        offCourseDistanceM: projected.offCourseDistanceM,
        segmentIndex: i - 1,
      };
    }

    cumulativeDistanceM += segmentLengthM;
  }

  if (!best) {
    return {
      snappedLngLat: polyline[0],
      courseDistanceM: 0,
      offCourseDistanceM: haversineDistanceM(point, polyline[0]),
      segmentIndex: 0,
    };
  }

  return best;
}