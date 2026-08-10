// Road ribbon edges from a centerline — dependency-free port of
// draw_width.build_edges, consuming a computeCenterline({metric:true}) result so
// it never re-projects lat/lng (one shared frame from centerline.mjs).
//
// Geometric, exactly like draw_width: the left/right cone LABELS are not trusted
// (they flip in some courses); a boundary cone's side is the SIGN of cross(T, rel)
// at its nearest centerline station, and its half-width is |perpendicular offset|.
// Per-side half-width is interpolated over periodic arc-length (gaps bridged),
// widened smoothly over center-cone runs, then the edges are lightly smoothed.
//
// Extension over draw_width (which is 2D): elevation + bank from the per-cone
// `alt` field. Left/right edge altitudes are interpolated separately, giving a
// banked cross-section; bank = atan2(zL - zR, width). No `alt` -> flat (Z=0).

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Circular Gaussian smoothing — periodic convolution with a normalized Gaussian
// kernel of half-width r = max(1, floor(3σ)). Equivalent to draw_width.circ_gauss
// (periodic pad + np.convolve 'same', sliced back to length n).
function circGauss(a, sigma) {
  const n = a.length;
  const r = Math.max(1, Math.floor(3 * sigma));
  const ker = [];
  let ksum = 0;
  for (let x = -r; x <= r; x++) { const v = Math.exp(-(x * x) / (2 * sigma * sigma)); ker.push(v); ksum += v; }
  for (let i = 0; i < ker.length; i++) ker[i] /= ksum;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) s += ker[j + r] * a[(((i + j) % n) + n) % n];
    out[i] = s;
  }
  return out;
}

// Linear interpolation with endpoint clamping; xs strictly ascending (np.interp).
function interp(x, xs, ys) {
  const m = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[m - 1]) return ys[m - 1];
  let lo = 0, hi = m - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

function nearestIndex(p, P) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < P.length; i++) {
    const d = (P[i][0] - p[0]) ** 2 + (P[i][1] - p[1]) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

// Periodic morphological dilation of a boolean array by L stations.
function dilate(a, L) {
  const n = a.length;
  const out = a.slice();
  for (let i = 0; i < n; i++) {
    if (out[i]) continue;
    for (let k = 1; k <= L; k++) {
      if (a[(((i - k) % n) + n) % n] || a[(i + k) % n]) { out[i] = true; break; }
    }
  }
  return out;
}

/**
 * Build road edges (and elevation/bank) from a centerline metric frame.
 * @param {object} cl  computeCenterline result with `.metric`
 * @param {{sigma?:number, centerBoost?:number, elevSigma?:number}} [opts]
 * @returns {{Le:number[][], Re:number[][], halfLeft:number[], halfRight:number[],
 *            width:number[], zC:number[], zL:number[], zR:number[], bank:number[],
 *            hasElevation:boolean, relief:number, smoothingSigma:number}}
 */
export function buildRoadEdges(cl, opts = {}) {
  if (!cl || !cl.metric) throw new Error("buildRoadEdges requires computeCenterline({metric:true})");
  const sigma = opts.sigma ?? 3.0;
  const centerBoost = opts.centerBoost ?? 5.0;
  const elevSigma = opts.elevSigma ?? 10.0;
  const extraWidthPerSide = opts.extraWidthPerSide ?? 1.0; // widen each side, except over slalom runs

  const P = cl.metric.P;                       // centerline stations [x,y]
  // Elevation samples deliberately come from wall cones only. Some center cones
  // are surveyed while lying down, so their antenna height is not comparable to
  // an upright boundary cone. Centers still shape the 2D slalom/width profile,
  // but never enter `boundary` or the altitude interpolation below.
  const boundary = cl.metric.left.concat(cl.metric.right); // wall cones [x,y,alt]
  const center = cl.metric.centers;            // center cones [x,y,alt]
  const trackWidth = cl.metric.width;
  const N = P.length;

  // unit tangent (central difference, periodic) + left-hand unit normal
  const T = new Array(N), Nn = new Array(N);
  for (let i = 0; i < N; i++) {
    const nx = P[(i + 1) % N], pv = P[(i - 1 + N) % N];
    let tx = nx[0] - pv[0], ty = nx[1] - pv[1];
    const m = Math.hypot(tx, ty) || 1;
    tx /= m; ty /= m;
    T[i] = [tx, ty];
    Nn[i] = [-ty, tx];
  }

  // arc-length station positions (periodic) + total loop length
  const seg = new Array(N);
  for (let i = 0; i < N; i++) seg[i] = dist(P[i], P[(i + 1) % N]);
  const sAt = new Array(N);
  sAt[0] = 0;
  for (let i = 1; i < N; i++) sAt[i] = sAt[i - 1] + seg[i - 1];
  const total = sAt[N - 1] + seg[N - 1];

  // per boundary cone: nearest station, signed perpendicular offset, arc-length
  const idx = boundary.map((b) => nearestIndex(b, P));
  const latSign = new Array(boundary.length);
  const sB = new Array(boundary.length);
  for (let k = 0; k < boundary.length; k++) {
    const i = idx[k];
    const rx = boundary[k][0] - P[i][0], ry = boundary[k][1] - P[i][1];
    latSign[k] = T[i][0] * ry - T[i][1] * rx;   // signed perp distance
    sB[k] = sAt[i];
  }

  // half-width profile for a side: cones' |offset| interpolated over periodic
  // arc-length, then smoothed. Empty side -> constant half of the auto width.
  const halfProfile = (keep) => {
    const pairs = [];
    for (let k = 0; k < boundary.length; k++) if (keep(latSign[k])) pairs.push([sB[k], Math.abs(latSign[k])]);
    if (pairs.length === 0) return new Array(N).fill(trackWidth / 2);
    pairs.sort((a, b) => a[0] - b[0]);
    const ss = pairs.map((p) => p[0]), oo = pairs.map((p) => p[1]);
    const sExt = ss.map((s) => s - total).concat(ss, ss.map((s) => s + total));
    const oExt = oo.concat(oo, oo);
    const prof = sAt.map((s) => interp(s, sExt, oExt));
    return circGauss(prof, sigma);
  };

  let hl = halfProfile((v) => v > 0);
  let hr = halfProfile((v) => v < 0);

  // slalomAmt[i] in 0..1: 1 over center-cone (slalom) runs, tapering to 0. Built
  // by a periodic morphological closing (so a run reads as one band, not
  // scalloping per cone) then smoothed.
  const slalomAmt = new Array(N).fill(0);
  if (center.length) {
    const cs = center.map((c) => sAt[nearestIndex(c, P)]);
    const mask = new Array(N).fill(false);
    for (let i = 0; i < N; i++) {
      let mn = Infinity;
      for (const c of cs) { let d = Math.abs(sAt[i] - c); d = Math.min(d, total - d); if (d < mn) mn = d; }
      mask[i] = mn < 2.5;
    }
    const L = 6;
    const notd = (a) => a.map((v) => !v);
    const closed = notd(dilate(notd(dilate(mask, L)), L));   // closing = erode(dilate)
    const sm = circGauss(closed.map((v) => (v ? 1 : 0)), 2.5);
    for (let i = 0; i < N; i++) slalomAmt[i] = sm[i];
  }
  // Over slalom runs: boost width by centerBoost (split both sides), tapered.
  // Everywhere else: widen each side by extraWidthPerSide. The two blend via
  // slalomAmt so the slalom keeps only its boost (no extra 1 m) and the join is
  // smooth.
  for (let i = 0; i < N; i++) {
    const add = slalomAmt[i] * (centerBoost / 2.0) + (1 - slalomAmt[i]) * extraWidthPerSide;
    hl[i] += add;
    hr[i] += add;
  }

  // edges = centerline ± N * half-width, then light final smoothing to remove
  // V-notches where a centerline kink amplifies onto the outer edge
  let Le = P.map((p, i) => [p[0] + Nn[i][0] * hl[i], p[1] + Nn[i][1] * hl[i]]);
  let Re = P.map((p, i) => [p[0] - Nn[i][0] * hr[i], p[1] - Nn[i][1] * hr[i]]);
  const es = 1.5;
  const LeX = circGauss(Le.map((p) => p[0]), es), LeY = circGauss(Le.map((p) => p[1]), es);
  const ReX = circGauss(Re.map((p) => p[0]), es), ReY = circGauss(Re.map((p) => p[1]), es);
  Le = LeX.map((x, i) => [x, LeY[i]]);
  Re = ReX.map((x, i) => [x, ReY[i]]);

  const width = hl.map((v, i) => v + hr[i]);

  // ---------------------------------------------------------------- elevation
  // Interpolate left/right edge altitudes separately from the alt-bearing cones
  // on each geometric side; a banked cross-section falls out. Flat when absent.
  const altProfile = (keep) => {
    const pairs = [];
    for (let k = 0; k < boundary.length; k++) {
      const a = boundary[k][2];
      if (keep(latSign[k]) && typeof a === "number" && Number.isFinite(a)) pairs.push([sB[k], a]);
    }
    if (pairs.length === 0) return null;
    pairs.sort((a, b) => a[0] - b[0]);
    const ss = pairs.map((p) => p[0]), oo = pairs.map((p) => p[1]);
    const sExt = ss.map((s) => s - total).concat(ss, ss.map((s) => s + total));
    const oExt = oo.concat(oo, oo);
    return circGauss(sAt.map((s) => interp(s, sExt, oExt)), elevSigma);
  };

  const zLraw = altProfile((v) => v > 0);
  const zRraw = altProfile((v) => v < 0);
  // A partially surveyed course should still retain its longitudinal relief. If
  // only one geometric side has valid altitude, reuse that adjacent profile for
  // the other side; this yields grade without inventing cross-track banking.
  const hasElevation = zLraw !== null || zRraw !== null;

  let zC, zL, zR, bank, relief;
  if (hasElevation) {
    const zLbase = zLraw ?? zRraw;
    const zRbase = zRraw ?? zLraw;
    const zCraw = zLbase.map((v, i) => (v + zRbase[i]) / 2);
    const offset = Math.min(...zCraw);
    zC = zCraw.map((v) => v - offset);
    zL = zLbase.map((v) => v - offset);
    zR = zRbase.map((v) => v - offset);
    bank = zL.map((v, i) => Math.atan2(v - zR[i], width[i] || 1e-9));
    relief = Math.max(...zC) - Math.min(...zC);
  } else {
    zC = new Array(N).fill(0);
    zL = new Array(N).fill(0);
    zR = new Array(N).fill(0);
    bank = new Array(N).fill(0);
    relief = 0;
  }

  return {
    Le, Re, halfLeft: hl, halfRight: hr, width,
    zC, zL, zR, bank, hasElevation, relief, smoothingSigma: elevSigma,
  };
}
