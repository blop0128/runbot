export function getSuspiciousSpeedScore(speedMps: number) {
  if (speedMps >= 10) return 5;
  if (speedMps >= 8) return 3;
  if (speedMps >= 7) return 2;
  if (speedMps >= 6) return 1;
  return 0;
}