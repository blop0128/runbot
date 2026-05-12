import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const envPath = path.join(projectRoot, ".env.local");

if (!fs.existsSync(envPath)) {
  throw new Error(".env.local 파일이 없습니다.");
}

const envText = fs.readFileSync(envPath, "utf8");

const tokenMatch = envText.match(/^NEXT_PUBLIC_MAPBOX_TOKEN=(.+)$/m);

if (!tokenMatch) {
  throw new Error(".env.local에 NEXT_PUBLIC_MAPBOX_TOKEN이 없습니다.");
}

const token = tokenMatch[1].trim();

if (!token.startsWith("pk.")) {
  throw new Error("Mapbox public token은 pk.로 시작해야 합니다.");
}

// [lng, lat]
// 현재는 여의도 한강공원 서쪽 방향 왕복 코스를 만들기 위한 대략 경유점.
// Directions API가 이 점들 사이를 실제 보행 경로로 연결한다.
const waypoints = [
  [126.9343, 37.5276],
  [126.929, 37.5284],
  [126.9235, 37.5291],
  [126.918, 37.5301],
  [126.9125, 37.531],
  [126.907, 37.5321],

  // Return route
  [126.9125, 37.531],
  [126.918, 37.5301],
  [126.9235, 37.5291],
  [126.929, 37.5284],
  [126.9343, 37.5276],
];

const coordinateString = waypoints
  .map(([lng, lat]) => `${lng},${lat}`)
  .join(";");

const url =
  `https://api.mapbox.com/directions/v5/mapbox/walking/${coordinateString}` +
  `?geometries=geojson&overview=full&steps=false&access_token=${token}`;

console.log("Requesting Mapbox walking route...");

const response = await fetch(url);

if (!response.ok) {
  const body = await response.text();
  throw new Error(`Mapbox Directions API error: ${response.status}\n${body}`);
}

const data = await response.json();

const route = data.routes?.[0];

if (!route || !route.geometry || !Array.isArray(route.geometry.coordinates)) {
  console.dir(data, { depth: null });
  throw new Error("Directions API 응답에서 route geometry를 찾지 못했습니다.");
}

const coordinates = route.geometry.coordinates;
const distanceM = Math.round(route.distance);

console.log(`Route distance: ${(distanceM / 1000).toFixed(2)} km`);
console.log(`Coordinate count: ${coordinates.length}`);

const output = `export type LngLat = [number, number];

export type Course = {
  id: string;
  name: string;
  distanceM: number;
  polyline: LngLat[];
};

export const HAN_RIVER_YEOUIDO_5K: Course = {
  id: "han-river-yeouido-5k",
  name: "Han River Yeouido 5K",
  distanceM: ${distanceM},
  polyline: ${JSON.stringify(coordinates, null, 2)} as LngLat[],
};
`;

const outPath = path.join(
  projectRoot,
  "src",
  "lib",
  "courses",
  "hanRiver.ts"
);

fs.writeFileSync(outPath, output, "utf8");

console.log(`Generated: ${outPath}`);