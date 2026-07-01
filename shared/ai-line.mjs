// Assetto Corsa AI line writer (fast_lane.ai / ideal_line.ai), version 7 —
// dependency-free port of ai_line.py. Byte layout from gro-ove/actools. Without
// this file AC crashes on session load (null track spline); the spatial grid is
// required by TimeAttack/Hotlap (evaluateTimeFromTrackSpline).
//
// One extension over ai_line.py: a per-point `camber` array (fed from road bank).
// ai_line.py hardcodes camber=0.0; pass camber all-zero to reproduce it byte-for-byte.
//
// Positions/forwards/normals are in AC world space (Y-up).

import { ByteWriter, ByteReader } from "./binio.mjs";

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Spatial grid: 10 m cells, each storing the `neighbors` spline point indices
// nearest to the cell centre (nearest-first). Brute-force nearest with a stable
// lowest-index tie-break, matching Kunos-track cKDTree output on unambiguous
// geometry. Returns { density, neighbors, minx, maxx, minz, maxz, nx, nz, nn }.
function buildGrid(positions) {
  const n = positions.length;
  const density = 10.0;
  const neighbors = Math.min(10, n);
  const xs = positions.map((p) => p[0]);
  const zs = positions.map((p) => p[2]);
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (let i = 0; i < n; i++) {
    if (xs[i] < minx) minx = xs[i];
    if (xs[i] > maxx) maxx = xs[i];
    if (zs[i] < minz) minz = zs[i];
    if (zs[i] > maxz) maxz = zs[i];
  }
  const nx = Math.max(1, Math.trunc((maxx - minx) / density));
  const nz = Math.max(1, Math.trunc((maxz - minz) / density));
  const nn = []; // nn[ix][iz] = [idx,...] (length neighbors)
  for (let ix = 0; ix < nx; ix++) {
    const col = [];
    for (let iz = 0; iz < nz; iz++) {
      const cx = minx + (ix + 0.5) * density;
      const cz = minz + (iz + 0.5) * density;
      const order = [];
      for (let j = 0; j < n; j++) {
        const dx = xs[j] - cx, dz = zs[j] - cz;
        order.push([dx * dx + dz * dz, j]);
      }
      order.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1])); // dist, then lowest index
      col.push(order.slice(0, neighbors).map((e) => e[1]));
    }
    nn.push(col);
  }
  return { density, neighbors, minx, maxx, minz, maxz, nx, nz, nn };
}

/**
 * Write a fast_lane.ai (version 7).
 * @param {{positions:number[][], forwards:number[][], normals:number[][],
 *          sideLeft:number[], sideRight:number[], speeds:number[],
 *          radii:number[], grades:number[], camber?:number[]}} arg
 * @returns {Uint8Array}
 */
export function writeFastLane({ positions, forwards, normals, sideLeft, sideRight,
                                speeds, radii, grades, camber }) {
  const n = positions.length;
  const cam = camber || new Array(n).fill(0.0);

  // cumulative arc length (closed loop, but points listed once)
  const lengths = new Array(n).fill(0.0);
  for (let i = 1; i < n; i++) lengths[i] = lengths[i - 1] + dist3(positions[i], positions[i - 1]);

  const w = new ByteWriter(1 << 16);
  w.i32(7);   // version
  w.i32(n);   // point count
  w.i32(0);   // lapTime
  w.i32(0);   // sampleCount
  for (let i = 0; i < n; i++) {
    w.vec3(positions[i]);
    w.f32(lengths[i]);
    w.i32(i);
  }
  w.i32(n);   // extra count
  for (let i = 0; i < n; i++) {
    // speed, gas, brake, obsoleteLatG, radius, sideL, sideR, camber, direction
    w.f32(speeds[i]); w.f32(1.0); w.f32(0.0); w.f32(0.0);
    w.f32(radii[i]); w.f32(sideLeft[i]); w.f32(sideRight[i]); w.f32(cam[i]); w.f32(0.0);
    w.vec3(normals[i]);       // Vec3 normal
    w.f32(lengths[i]);        // length
    w.vec3(forwards[i]);      // Vec3 forward
    w.f32(0.0); w.f32(grades[i]); // tag, grade
  }

  const g = buildGrid(positions);
  w.i32(1);                  // hasGrid
  w.f32(g.maxx); w.f32(0.0); w.f32(g.maxz);   // MaxExtreme
  w.f32(g.minx); w.f32(0.0); w.f32(g.minz);   // MinExtreme
  w.i32(g.neighbors);        // NeighborsConsideredNumber
  w.f32(g.density);          // SamplingDensity
  w.i32(g.nx);               // itemCount (X cells)
  for (let ix = 0; ix < g.nx; ix++) {
    w.i32(g.nz);             // subCount (Z cells)
    for (let iz = 0; iz < g.nz; iz++) {
      w.i32(g.neighbors);
      for (const idx of g.nn[ix][iz]) w.i32(idx);
    }
  }
  return w.toBytes();
}

/**
 * Minimal reader for round-trip tests: version/count/hasGrid + grid dims, and
 * proves the writer is self-consistent via leftover === 0.
 */
export function readFastLane(data) {
  const r = new ByteReader(data);
  const version = r.i32();
  const count = r.i32();
  r.i32(); r.i32();            // lapTime, sampleCount
  r.take(count * 20);         // points: vec3 + f32 + i32
  const extraCount = r.i32();
  r.take(extraCount * 72);    // extras
  const hasGrid = r.i32();
  const grid = { neighbors: 0, nx: 0, nz: 0 };
  if (hasGrid) {
    r.take(12); r.take(12);   // MaxExtreme, MinExtreme
    grid.neighbors = r.i32();
    r.f32();                  // density
    grid.nx = r.i32();
    for (let ix = 0; ix < grid.nx; ix++) {
      const nz = r.i32();
      if (ix === 0) grid.nz = nz;
      for (let iz = 0; iz < nz; iz++) {
        const cnt = r.i32();
        r.take(cnt * 4);
      }
    }
  }
  return { version, count, extraCount, hasGrid, grid, leftover: r.leftover };
}
