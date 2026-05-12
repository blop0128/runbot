export type LngLat = [number, number];

export type Course = {
  id: string;
  name: string;
  distanceM: number;
  polyline: LngLat[];
};

export const HAN_RIVER_YEOUIDO_5K: Course = {
  id: "han-river-yeouido-5k",
  name: "Han River Yeouido 5K",
  distanceM: 5000,
  polyline: [
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
  ],
};