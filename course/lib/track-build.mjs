// Build the AC track model (kn5 + fast_lane.ai + meta) from a centerline and its
// road edges — dependency-free port of build_track.py. Elevation is BANKED: the
// road mesh uses per-edge Z (zL/zR) and the AI line carries real camber (bank),
// extending build_track.py's flat single-Z pipeline.
//
// AC coordinates are Y-up: world (x_east, y_north, z_up) -> (x, z, -y) via acVec.

import {
  writeKn5, meshNode, dummyNode, translationMatrix, acVec, IDENTITY,
} from "./kn5.mjs";
import { writeFastLane } from "./ai-line.mjs";
import { asphaltDDS, grassDDS, coneDDS } from "./dds.mjs";

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v) => Math.hypot(v[0], v[1], v[2]);

// Ribbon between left/right edges (banked: left vertex uses zL, right uses zR).
// Returns AC-space {positions, normals, uvs, indices}; vertex 2i = left[i], 2i+1 = right[i].
function buildRoadMesh(Le, Re, zL, zR, tile = 4.0) {
  const N = Le.length;
  const verts = new Array(2 * N);          // world [x_e, y_n, z_up]
  for (let i = 0; i < N; i++) {
    verts[2 * i] = [Le[i][0], Le[i][1], zL[i]];
    verts[2 * i + 1] = [Re[i][0], Re[i][1], zR[i]];
  }
  let tris = [];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const a = 2 * i, b = 2 * i + 1, c = 2 * j, d = 2 * j + 1;
    tris.push([a, b, d], [a, d, c]);
  }
  const faceNormal = (t) => {
    const p0 = verts[t[0]], p1 = verts[t[1]], p2 = verts[t[2]];
    return cross3([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]],
                  [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]);
  };
  let fns = tris.map(faceNormal);
  let meanZ = fns.reduce((s, f) => s + f[2], 0) / fns.length;
  if (meanZ < 0) {                         // ensure road faces up (+z); flip winding
    tris = tris.map((t) => [t[0], t[2], t[1]]);
    fns = tris.map(faceNormal);
  }
  const normals = Array.from({ length: 2 * N }, () => [0, 0, 0]);
  for (let k = 0; k < tris.length; k++) {
    for (const vi of tris[k]) { normals[vi][0] += fns[k][0]; normals[vi][1] += fns[k][1]; normals[vi][2] += fns[k][2]; }
  }
  for (let v = 0; v < 2 * N; v++) {
    const ln = norm3(normals[v]);
    normals[v] = ln > 1e-9 ? [normals[v][0] / ln, normals[v][1] / ln, normals[v][2] / ln] : [0, 0, 1];
  }
  const s = new Array(N).fill(0);
  for (let i = 1; i < N; i++) s[i] = s[i - 1] + dist(Le[i], Le[i - 1]);
  const uvs = new Array(2 * N);
  for (let i = 0; i < N; i++) {
    uvs[2 * i] = [0, s[i] / tile];
    uvs[2 * i + 1] = [1, s[i] / tile];
  }
  const positions = verts.map((p) => [p[0], p[2], -p[1]]);   // -> AC
  const nrmAc = normals.map((n) => [n[0], n[2], -n[1]]);
  const indices = tris.flat();
  return { positions, normals: nrmAc, uvs, indices };
}

// Big flat grass plane around the track so you can't fall off the world.
function buildGround(Le, Re, zLevel = -0.05, margin = 60.0, tile = 6.0) {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const arr of [Le, Re]) for (const [x, y] of arr) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  const x0 = minx - margin, x1 = maxx + margin, y0 = miny - margin, y1 = maxy + margin;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return {
    positions: corners.map(([cx, cy]) => [cx, zLevel, -cy]),
    normals: corners.map(() => [0, 1, 0]),
    uvs: corners.map(([cx, cy]) => [cx / tile, cy / tile]),
    indices: [0, 1, 2, 0, 2, 3],
  };
}

// Small cones (autocross size) at the given cone positions, merged into one
// AC-space mesh. Each is a base ring + apex, placed on the road at the nearest
// centerline station's elevation. Visual only (car passes through).
function buildCones(pts, P, zC, { height = 0.30, radius = 0.12, segs = 8 } = {}) {
  const groundZ = (cx, cy) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < P.length; i++) {
      const d = (P[i][0] - cx) ** 2 + (P[i][1] - cy) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return zC[bi] || 0;
  };
  const positions = [], normals = [], uvs = [], indices = [];
  for (const c of pts) {
    const cx = c[0], cy = c[1], z0 = groundZ(cx, cy);
    const base0 = positions.length;
    // apex
    positions.push([cx, cy, z0 + height]);
    normals.push([0, 0, 1]);
    uvs.push([0.5, 1]);
    // base ring
    for (let i = 0; i < segs; i++) {
      const t = (2 * Math.PI * i) / segs;
      const ce = Math.cos(t), se = Math.sin(t);
      positions.push([cx + radius * ce, cy + radius * se, z0]);
      const n = [ce, se, 0.4];
      const nl = norm3(n);
      normals.push([n[0] / nl, n[1] / nl, n[2] / nl]);
      uvs.push([i / segs, 0]);
    }
    for (let i = 0; i < segs; i++) {
      const a = base0;                         // apex
      const b = base0 + 1 + i;                 // base i
      const d = base0 + 1 + ((i + 1) % segs);  // base i+1
      indices.push(a, b, d);
    }
  }
  // world (x_e, y_n, z_up) -> AC (x, z, -y)
  return {
    positions: positions.map((p) => [p[0], p[2], -p[1]]),
    normals: normals.map((n) => [n[0], n[2], -n[1]]),
    uvs,
    indices,
  };
}

// 4×4 (row-major, translation in col 3) in AC space: +Z faces the track tangent.
function spawnMatrix(centerWorld, tangentWorld) {
  const pos = [centerWorld[0], centerWorld[2], -centerWorld[1]];
  let f = [tangentWorld[0], 0.0, -tangentWorld[1]];
  const fn = norm3(f) || 1.0;
  f = [f[0] / fn, f[1] / fn, f[2] / fn];
  const up = [0, 1, 0];
  let right = cross3(up, f);
  const rn = norm3(right) || 1.0;
  right = [right[0] / rn, right[1] / rn, right[2] / rn];
  const up2 = cross3(f, right);
  return [
    [right[0], up2[0], f[0], pos[0]],
    [right[1], up2[1], f[1], pos[1]],
    [right[2], up2[2], f[2], pos[2]],
    [0, 0, 0, 1],
  ];
}

function mat(name, texture, diffuse, ambient, specular) {
  return {
    name, shader: "ksPerPixel",
    props: [
      ["ksDiffuse", diffuse, [0, 0], [0, 0, 0], [0, 0, 0, 0]],
      ["ksAmbient", ambient, [0, 0], [0, 0, 0], [0, 0, 0, 0]],
      ["ksSpecular", specular, [0, 0], [0, 0, 0], [0, 0, 0, 0]],
    ],
    textures: [["txDiffuse", texture]],
  };
}

// AI racing line arrays from the centerline (matches build_track.write_ai_line,
// plus real camber from bank). Returns { bytes, data } where data feeds the
// enriched JSON.
function buildAiLine(P, zC, halfLeft, halfRight, bank) {
  const N = P.length;
  const posAc = P.map((p, i) => [p[0], zC[i], -p[1]]);
  const fwd = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = posAc[(i - 1 + N) % N], b = posAc[(i + 1) % N];
    let v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const m = norm3(v) + 1e-9;
    fwd[i] = [v[0] / m, v[1] / m, v[2] / m];
  }
  const normals = P.map(() => [0, 1, 0]);
  const radii = new Array(N), speeds = new Array(N), grades = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = P[(i - 1 + N) % N], b = P[i], c = P[(i + 1) % N];
    const ab = dist(a, b), bc = dist(b, c), ca = dist(c, a);
    const area = 0.5 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
    let r = area > 1e-6 ? (ab * bc * ca) / (4 * area + 1e-9) : 1000.0;
    r = Math.max(5, Math.min(1000, r));
    radii[i] = r;
    speeds[i] = Math.max(8, Math.min(40, Math.sqrt(8.0 * r)));
    const hd = dist(P[(i + 1) % N], P[(i - 1 + N) % N]);
    grades[i] = (zC[(i + 1) % N] - zC[(i - 1 + N) % N]) / (hd + 1e-9);
  }
  const camber = bank.slice();
  const bytes = writeFastLane({
    positions: posAc, forwards: fwd, normals,
    sideLeft: halfLeft, sideRight: halfRight, speeds, radii, grades, camber,
  });
  return { bytes, data: { speeds, radii, grades, camber } };
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/**
 * Build the full track model.
 * @param {object} cl computeCenterline result with `.metric`
 * @param {object} edges buildRoadEdges result
 * @param {{name:string, reverse?:boolean}} opts
 * @returns {{kn5:Uint8Array, ai:Uint8Array, aiData:object, meta:object, edges:object}}
 */
export function buildTrackModel(cl, edges, opts = {}) {
  const name = opts.name || "course";
  const reverse = opts.reverse ?? false;

  let P = cl.metric.P;
  let { Le, Re, halfLeft, halfRight, zC, zL, zR, bank, width } = edges;
  const N = P.length;

  if (reverse) {
    // flip lap direction, keep the start point (np.roll(order[::-1], 1)); driving
    // left/right swap with direction, so swap the two edges and negate bank.
    let order = [];
    for (let i = N - 1; i >= 0; i--) order.push(i);
    order = [order[N - 1], ...order.slice(0, N - 1)];
    const reord = (a) => order.map((i) => a[i]);
    P = reord(P);
    [Le, Re] = [reord(Re), reord(Le)];
    [halfLeft, halfRight] = [reord(halfRight), reord(halfLeft)];
    [zL, zR] = [reord(zR), reord(zL)];
    zC = reord(zC);
    bank = reord(bank).map((b) => -b);
    width = reord(width);
  }

  const roadMesh = buildRoadMesh(Le, Re, zL, zR);
  const road = meshNode("1ROAD", roadMesh.positions, roadMesh.normals, roadMesh.uvs, roadMesh.indices, 0);
  const ground = buildGround(Le, Re);
  const grass = meshNode("1GRASS", ground.positions, ground.normals, ground.uvs, ground.indices, 1);

  // A cone at every cone position, coloured by side: left = yellow, right =
  // blue, center = red. Names do NOT start with a digit ("CONE_*"), so AC keeps
  // them graphics-only (no collision — the car passes through). Materials 2,3,4
  // in the order of the sides that actually have cones.
  const M = cl.metric || {};
  const coneSpecs = [
    { tag: "L", pts: M.left, rgb: [240, 205, 15] },   // left  -> yellow
    { tag: "R", pts: M.right, rgb: [30, 90, 235] },   // right -> blue
    { tag: "C", pts: M.centers, rgb: [225, 35, 30] }, // center-> red
  ].filter((s) => s.pts && s.pts.length);
  const coneNodes = coneSpecs.map((s, i) => {
    const cm = buildCones(s.pts, P, zC);
    return meshNode(`CONE_${s.tag}`, cm.positions, cm.normals, cm.uvs, cm.indices, 2 + i);
  });

  const c0 = [(Le[0][0] + Re[0][0]) / 2, (Le[0][1] + Re[0][1]) / 2, zC[0]];
  const tan = [P[1][0] - P[0][0], P[1][1] - P[0][1]];
  const nodes = [
    road, grass,
    ...coneNodes,
    dummyNode("AC_PIT_0", spawnMatrix(c0, tan)),
    dummyNode("AC_START_0", spawnMatrix(c0, tan)),
    dummyNode("AC_TIME_0_L", translationMatrix(acVec([Le[0][0], Le[0][1], zL[0]]))),
    dummyNode("AC_TIME_0_R", translationMatrix(acVec([Re[0][0], Re[0][1], zR[0]]))),
  ];
  const root = dummyNode(name, IDENTITY, nodes);

  const textures = [["asphalt.dds", asphaltDDS()], ["grass.dds", grassDDS()]];
  const materials = [
    mat("road", "asphalt.dds", 0.6, 0.5, 0.2),
    mat("grass", "grass.dds", 0.5, 0.4, 0.0),
  ];
  coneSpecs.forEach((s) => {
    const tex = `cone_${s.tag}.dds`;
    textures.push([tex, coneDDS(s.rgb)]);
    materials.push(mat(`cone_${s.tag}`, tex, 0.85, 0.75, 0.05));
  });
  const kn5 = writeKn5({ textures, materials, root });

  const ai = buildAiLine(P, zC, halfLeft, halfRight, bank);

  let length = 0;
  for (let i = 0; i < N; i++) length += dist(P[i], P[(i + 1) % N]);
  const meta = {
    name,
    length,
    medianWidth: median(width),
    minWidth: Math.min(...width),
    run: "clockwise",
    reverse,
  };

  return {
    kn5, ai: ai.bytes, aiData: ai.data, meta,
    P,   // stations in built order (== cl.metric.P unless reversed)
    edges: { Le, Re, halfLeft, halfRight, zC, zL, zR, bank, width },
  };
}
