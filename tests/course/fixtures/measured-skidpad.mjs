// The surveyed 2026 skidpad, wired into the shape the course APIs pass around.
// skidpad_measured_2026.json holds only raw cone rows, so the marker set and the
// official visit order live here and are shared by every test that needs a real
// branched course (guided-route, route-mode).

import { readFileSync } from "node:fs";

const LAT0 = 35.292;
const LNG0 = 126.574;
const MLAT = 110540;
const MLNG = 111320 * Math.cos((LAT0 * Math.PI) / 180);

export function ll(x, y) {
  return { lat: LAT0 + y / MLAT, lng: LNG0 + x / MLNG };
}

// entry -> waist -> left circle twice -> waist -> right circle twice -> exit.
// The waist marker repeats, which is exactly what the automatic loop reduction
// cannot express and what the marker router exists for.
const MARKER_XY = [
  [0, -12.5, "진입"], [0, 0, "허리"],
  [-9.1, 9, "좌상"], [-18, 0, "좌외"], [-9.1, -9, "좌하"],
  [8.8, 9, "우상"], [18, 0, "우외"], [8.8, -9, "우하"],
  [0, 11.5, "진출"],
];

export function measuredSkidpadFixture() {
  const fixture = JSON.parse(readFileSync(new URL("./skidpad_measured_2026.json", import.meta.url), "utf8"));
  const cones = fixture.cones.map(([side, x, y, z], index) => ({
    id: index + 1,
    ...ll(x, y),
    alt: fixture.altitudeBase + z,
    side,
  }));
  const markers = MARKER_XY.map(([x, y, label], index) => ({ id: index + 1, ...ll(x, y), label }));
  const [entry, waist, lt, lf, lb, rt, rf, rb, exit] = markers.map((marker) => marker.id);
  const steps = [
    entry, waist,
    lt, lf, lb, waist, lt, lf, lb, waist,
    rt, rf, rb, waist, rt, rf, rb, waist,
    exit,
  ];
  return { cones, markers, steps, centers: [ll(-9.098, -0.413), ll(8.81, -0.008)] };
}
