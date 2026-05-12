export function paceToSpeedMps(paceSecPerKm: number): number {
  return 1000 / paceSecPerKm;
}

export function clampPaceSecPerKm(paceSecPerKm: number): number {
  const MIN_PACE = 150; // 2:30/km
  const MAX_PACE = 900; // 15:00/km

  return Math.min(Math.max(paceSecPerKm, MIN_PACE), MAX_PACE);
}

export function formatPace(paceSecPerKm: number): string {
  const minutes = Math.floor(paceSecPerKm / 60);
  const seconds = Math.round(paceSecPerKm % 60);

  return `${minutes}:${seconds.toString().padStart(2, "0")}/km`;
}