// Track centerline from cone positions — dependency-free port of centerline.py.
// Keep this file dependency-free (no npm imports) so it can run unchanged in the
// browser (course MapView draws the line) and in Node (tests + future export
// targets such as Assetto Corsa). Mirrors shared/geo.mjs's browser+Node contract.
//
// Method (auto-derived from the data, faithfully ported from centerline.py):
//   1. Project lat/lng -> local metres (equirectangular about the centroid).
//   2. Delaunay-triangulate the wall cones; a left/right edge is a "track
//      crossing" if short (a corridor) OR longer but its midpoint sits next to a
//      center cone (a slalom). The two crossings in a triangle connect, giving a
//      graph that stays connected THROUGH slaloms and never cuts across infield.
//   3. Trace the graph into chains; order them with a direction-aware Held-Karp
//      closed tour; detect closed loop vs open path.
//   4. Fill gaps with slalom center cones, else single-wall offset-follow.
//   5. Resample + light smoothing + safety clamp + slalom snapping.
//
// One deliberate divergence from centerline.py: the slalom pass uses scipy's
// FITPACK smoothing spline (splprep). That is impractical to reimplement 1:1, so
// snapSlaloms() uses a centripetal Catmull-Rom through the slalom cones plus
// run-in/run-out anchors — visually equivalent (passes next to the cones,
// tangent-continuous) but not byte-identical to the Python output.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ----------------------------------------------------------------- projection
// Returns { P, back } where P[i] = [x, y] metres and back(x, y) -> [lat, lng].
function project(cones) {
  const lat0 = cones.reduce((s, c) => s + c.lat, 0) / cones.length;
  const lng0 = cones.reduce((s, c) => s + c.lng, 0) / cones.length;
  const mlat = 110540.0;
  const mlng = 111320.0 * Math.cos((lat0 * Math.PI) / 180);
  const P = cones.map((c) => [(c.lng - lng0) * mlng, (c.lat - lat0) * mlat]);
  const back = (x, y) => [lat0 + y / mlat, lng0 + x / mlng];
  return { P, back };
}

// ----------------------------------------------------------------- nearest cone
function nearestDist(p, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = dist(p, pts[i]);
    if (d < best) best = d;
  }
  return best;
}

// k nearest points (brute force; cone counts are in the hundreds). Returns the
// candidate points themselves, ordered nearest-first.
function nearestK(p, pts, k) {
  const idx = pts.map((q, i) => [dist(p, q), i]);
  idx.sort((a, b) => a[0] - b[0]);
  const out = [];
  const lim = Math.min(k, pts.length);
  for (let i = 0; i < lim; i++) out.push(pts[idx[i][1]]);
  return out;
}

// ----------------------------------------------------------------- Delaunay
// Bowyer-Watson incremental triangulation (replaces scipy.spatial.Delaunay).
// Returns triangles as [i, j, k] index triples into pts. Consumed identically
// by medialChains, which only inspects each triangle's three edges.
function delaunay(pts) {
  const n = pts.length;
  if (n < 3) return [];

  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of pts) {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }
  const dmax = Math.max(maxx - minx, maxy - miny) || 1;
  const midx = (minx + maxx) / 2, midy = (miny + maxy) / 2;

  // Super-triangle (CCW) large enough to contain every circumcircle.
  const V = pts.slice();
  const s0 = V.length; V.push([midx - 20 * dmax, midy - dmax]);
  const s1 = V.length; V.push([midx + 20 * dmax, midy - dmax]);
  const s2 = V.length; V.push([midx, midy + 20 * dmax]);

  // Orient a,b,c CCW (positive signed area); null if collinear.
  const ccw3 = (a, b, c) => {
    const o = (V[b][0] - V[a][0]) * (V[c][1] - V[a][1]) -
              (V[b][1] - V[a][1]) * (V[c][0] - V[a][0]);
    if (Math.abs(o) < 1e-12) return null;
    return o > 0 ? [a, b, c] : [a, c, b];
  };

  // p inside circumcircle of CCW triangle t -> determinant > 0.
  const inCircle = (t, p) => {
    const ax = V[t[0]][0] - V[p][0], ay = V[t[0]][1] - V[p][1];
    const bx = V[t[1]][0] - V[p][0], by = V[t[1]][1] - V[p][1];
    const cx = V[t[2]][0] - V[p][0], cy = V[t[2]][1] - V[p][1];
    const det = (ax * ax + ay * ay) * (bx * cy - cx * by) -
                (bx * bx + by * by) * (ax * cy - cx * ay) +
                (cx * cx + cy * cy) * (ax * by - bx * ay);
    return det > 0;
  };

  let tris = [[s0, s1, s2]];
  for (let i = 0; i < n; i++) {
    const bad = [];
    for (let t = 0; t < tris.length; t++) if (inCircle(tris[t], i)) bad.push(t);

    // Boundary of the cavity = edges that belong to exactly one bad triangle.
    const edges = new Map();
    for (const t of bad) {
      const [a, b, c] = tris[t];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        const e = edges.get(key);
        if (e) e.cnt++;
        else edges.set(key, { u, v, cnt: 1 });
      }
    }
    for (let j = bad.length - 1; j >= 0; j--) tris.splice(bad[j], 1);
    for (const { u, v, cnt } of edges.values()) {
      if (cnt !== 1) continue;
      const tri = ccw3(u, v, i);
      if (tri) tris.push(tri);
    }
  }

  // Drop triangles that still reference a super-triangle vertex.
  const out = [];
  for (const [a, b, c] of tris) if (a < n && b < n && c < n) out.push([a, b, c]);
  return out;
}

// ----------------------------------------------------------------- medial graph
function medialChains(P, S, width, centers) {
  const tris = delaunay(P);

  const crossing = (a, b) => {
    const L = dist(P[a], P[b]);
    const mid = [(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2];
    if (L < 2.6 * width) return mid;
    if (centers.length && L < 4.5 * width && nearestDist(mid, centers) < 1.0 * width) return mid;
    return null;
  };
  const key = (p) => `${Math.round(p[0] * 2) / 2}_${Math.round(p[1] * 2) / 2}`;

  const adj = new Map();   // key -> Set(key)
  const nodes = new Map(); // key -> [x, y]
  const link = (ka, kb) => {
    if (!adj.has(ka)) adj.set(ka, new Set());
    adj.get(ka).add(kb);
  };

  for (const s of tris) {
    const cross = [];
    for (const [a, b] of [[s[0], s[1]], [s[1], s[2]], [s[2], s[0]]]) {
      if (S[a] !== S[b]) {
        const m = crossing(a, b);
        if (m !== null) cross.push(m);
      }
    }
    if (cross.length === 2) {
      const ka = key(cross[0]), kb = key(cross[1]);
      nodes.set(ka, cross[0]);
      nodes.set(kb, cross[1]);
      if (ka !== kb) { link(ka, kb); link(kb, ka); }
    }
  }

  const seen = new Set();
  const trace = (start) => {
    const ch = [start];
    seen.add(start);
    let prev = null, cur = start;
    while (true) {
      const nbrs = [...(adj.get(cur) || [])];
      let nb = nbrs.filter((m) => m !== prev && !seen.has(m));
      if (nb.length === 0) nb = nbrs.filter((m) => !seen.has(m));
      if (nb.length === 0) break;
      const nxt = nb[0];
      ch.push(nxt);
      seen.add(nxt);
      prev = cur;
      cur = nxt;
    }
    return ch;
  };

  const chains = [];
  for (const k of adj.keys()) {
    if ((adj.get(k).size === 1) && !seen.has(k)) chains.push(trace(k).map((x) => nodes.get(x)));
  }
  for (const k of adj.keys()) {
    if (!seen.has(k)) chains.push(trace(k).map((x) => nodes.get(x)));
  }
  return chains.filter((c) => c.length >= 3);
}

// ----------------------------------------------------------------- chain order
// Direction-aware globally-optimal closed tour over the chains (Held-Karp DP).
function heldKarpTour(elems, alpha = 2.5) {
  const n = elems.length;
  if (n === 1) return elems;
  if (n > 13) return greedyTour(elems); // DP is exponential; fall back if huge

  const unit = (v) => {
    const m = Math.hypot(v[0], v[1]) || 1.0;
    return [v[0] / m, v[1] / m];
  };
  const EP = elems.map((el) => {
    const tin0 = unit([el[1][0] - el[0][0], el[1][1] - el[0][1]]);
    const tout1 = unit([el[el.length - 1][0] - el[el.length - 2][0],
                        el[el.length - 1][1] - el[el.length - 2][1]]);
    return {
      0: { entry: el[0], exit: el[el.length - 1], ent: tin0, ext: tout1 },
      1: { entry: el[el.length - 1], exit: el[0], ent: [-tout1[0], -tout1[1]], ext: [-tin0[0], -tin0[1]] },
    };
  });
  const ang = (u, v) => Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
  const conn = (i, di, j, dj) => {
    const ex = EP[i][di].exit, en = EP[j][dj].entry;
    const g = dist(ex, en);
    if (g < 1e-6) return 0.0;
    const gd = [(en[0] - ex[0]) / g, (en[1] - ex[1]) / g];
    const t1 = ang(EP[i][di].ext, gd), t2 = ang(gd, EP[j][dj].ent);
    return g * (1 + alpha * ((1 - Math.cos(t1)) + (1 - Math.cos(t2))));
  };

  const dp = new Map(), par = new Map();
  const K = (mask, i, di) => `${mask}_${i}_${di}`;
  for (const d0 of [0, 1]) dp.set(K(1, 0, d0), 0.0);
  for (let step = 1; step < n; step++) {
    for (const [k, cost] of [...dp]) {
      const [mask, i, di] = k.split("_").map(Number);
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        for (const dj of [0, 1]) {
          const nc = cost + conn(i, di, j, dj);
          const nk = K(mask | (1 << j), j, dj);
          if (nc < (dp.has(nk) ? dp.get(nk) : Infinity)) { dp.set(nk, nc); par.set(nk, k); }
        }
      }
    }
  }
  const full = (1 << n) - 1;
  let best = null, bestKey = null;
  for (let i = 0; i < n; i++) {
    for (const di of [0, 1]) {
      const st = K(full, i, di);
      if (dp.has(st)) {
        const tot = dp.get(st) + conn(i, di, 0, 0);
        if (best === null || tot < best) { best = tot; bestKey = st; }
      }
    }
  }
  const seq = [];
  let st = bestKey;
  while (par.has(st)) {
    const [, i, di] = st.split("_").map(Number);
    seq.push([i, di]);
    st = par.get(st);
  }
  seq.push([0, 0]);
  seq.reverse();
  return seq.map(([i, di]) => (di === 0 ? elems[i] : elems[i].slice().reverse()));
}

// Greedy nearest-endpoint chaining — only used when chain count is too large
// for the exact DP (does not happen for real single-course cone fields).
function greedyTour(elems) {
  const n = elems.length;
  const used = new Array(n).fill(false);
  const order = [];
  let cur = elems[0][0];
  for (let s = 0; s < n; s++) {
    let bi = -1, bflip = false, bd = Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const d0 = dist(cur, elems[i][0]);
      const d1 = dist(cur, elems[i][elems[i].length - 1]);
      const d = Math.min(d0, d1);
      if (d < bd) { bd = d; bi = i; bflip = d1 < d0; }
    }
    used[bi] = true;
    const chain = bflip ? elems[bi].slice().reverse() : elems[bi].slice();
    order.push(chain);
    cur = chain[chain.length - 1];
  }
  return order;
}

// ----------------------------------------------------------------- gap filling
function centersInGap(A, B, centers, width) {
  let ux = B[0] - A[0], uy = B[1] - A[1];
  const L = Math.hypot(ux, uy);
  if (L < 1e-6) return [];
  ux /= L; uy /= L;
  const got = [];
  for (const [x, y] of centers) {
    const px = (x - A[0]) * ux + (y - A[1]) * uy;
    const lat = Math.abs(-(x - A[0]) * uy + (y - A[1]) * ux);
    if (px > 0 && px < L && lat < 2.5 * width) got.push([px, [x, y]]);
  }
  got.sort((a, b) => a[0] - b[0]);
  return got.map((g) => g[1]);
}

function offsetFollow(A, B, left, right, width) {
  let ux = B[0] - A[0], uy = B[1] - A[1];
  const L = Math.hypot(ux, uy);
  if (L < 2) return [];
  ux /= L; uy /= L;
  const band = [];
  for (const w of left.concat(right)) {
    const px = (w[0] - A[0]) * ux + (w[1] - A[1]) * uy;
    const lat = -(w[0] - A[0]) * uy + (w[1] - A[1]) * ux;
    if (px > 0.5 && px < L - 0.5 && Math.abs(lat) < 2.5 * width) band.push([px, w]);
  }
  if (band.length < 2) return [];
  band.sort((a, b) => a[0] - b[0]);
  const idx = band.map((b) => b[1]);
  const latf = (p) => Math.abs(-(p[0] - A[0]) * uy + (p[1] - A[1]) * ux);
  const pts = [];
  for (let i = 0; i < idx.length; i++) {
    const w = idx[i];
    const a = idx[Math.max(0, i - 1)];
    const b = idx[Math.min(idx.length - 1, i + 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1];
    const tn = Math.hypot(tx, ty) || 1;
    const nx = -ty / tn, ny = tx / tn;
    const c1 = [w[0] + (width / 2) * nx, w[1] + (width / 2) * ny];
    const c2 = [w[0] - (width / 2) * nx, w[1] - (width / 2) * ny];
    pts.push(latf(c1) < latf(c2) ? c1 : c2);
  }
  return pts;
}

function buildLoop(route, left, right, centers, width) {
  const n = route.length;
  const gaps = [];
  for (let k = 0; k < n; k++) {
    gaps.push(dist(route[k][route[k].length - 1], route[(k + 1) % n][0]));
  }
  let maxGap = -Infinity, b = 0;
  for (let k = 0; k < n; k++) if (gaps[k] > maxGap) { maxGap = gaps[k]; b = k; }

  const A0 = route[b][route[b].length - 1], B0 = route[(b + 1) % n][0];
  const cig0 = centersInGap(A0, B0, centers, width);
  const span = cig0.length ? cig0 : offsetFollow(A0, B0, left, right, width);
  const closed = !(maxGap > 8 * width && span.length === 0);
  if (!closed) route = route.slice(b + 1).concat(route.slice(0, b + 1));

  let loop = [];
  const last = closed ? n : n - 1;
  for (let k = 0; k < n; k++) {
    loop = loop.concat(route[k]);
    if (k < last) {
      const A = route[k][route[k].length - 1], B = route[(k + 1) % n][0];
      if (dist(A, B) > 1.5 * width) {
        const cig = centersInGap(A, B, centers, width);
        loop = loop.concat(cig.length ? cig : offsetFollow(A, B, left, right, width));
      }
    }
  }
  if (closed) loop.push(loop[0]);
  return { loop, closed };
}

// ----------------------------------------------------------------- resample / smooth
function resample(poly, step, closed) {
  const cum = [0.0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[cum.length - 1] + dist(poly[i - 1], poly[i]));
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.floor(total / step));
  const out = [];
  const count = closed ? n : n + 1;
  for (let k = 0; k < count; k++) {
    const s = closed ? (total * k) / n : Math.min(total, k * step);
    let j = 0;
    while (j < cum.length - 1 && cum[j + 1] < s) j++;
    if (j >= poly.length - 1) { out.push(poly[poly.length - 1]); continue; }
    const seg = cum[j + 1] - cum[j];
    const t = seg === 0 ? 0 : (s - cum[j]) / seg;
    out.push([poly[j][0] + t * (poly[j + 1][0] - poly[j][0]),
              poly[j][1] + t * (poly[j + 1][1] - poly[j][1])]);
  }
  return out;
}

function smooth(pts, closed, w = 1) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, c = 0;
    if (closed) {
      for (let j = -w; j <= w; j++) {
        const p = pts[((i + j) % n + n) % n];
        sx += p[0]; sy += p[1]; c++;
      }
    } else {
      const lo = Math.max(0, i - w), hi = Math.min(n, i + w + 1);
      for (let j = lo; j < hi; j++) { sx += pts[j][0]; sy += pts[j][1]; c++; }
    }
    out.push([sx / c, sy / c]);
  }
  return out;
}

// ----------------------------------------------------------------- safety clamp
function projOnSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  if (L2 < 1e-9) return [a, dist(p, a)];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  const q = [a[0] + t * dx, a[1] + t * dy];
  return [q, dist(p, q)];
}

function nearestWall(p, pts, width) {
  const cand = nearestK(p, pts, 6);
  let best = null;
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      if (dist(cand[i], cand[j]) < 1.9 * width) {
        const [q, dd] = projOnSeg(p, cand[i], cand[j]);
        if (best === null || dd < best[1]) best = [q, dd];
      }
    }
  }
  return best || [cand[0], dist(p, cand[0])];
}

function clampInside(pts, closed, left, right, width,
                     minFrac = 0.40, diffFrac = 0.45, nudge = 1.0, iters = 3) {
  for (let it = 0; it < iters; it++) {
    const out = [];
    for (const p of pts) {
      const [pL, dL] = nearestWall(p, left, width);
      const [pR, dR] = nearestWall(p, right, width);
      const both = dL < 1.6 * width && dR < 1.6 * width;
      const bad = both && (Math.min(dL, dR) < minFrac * width || Math.abs(dL - dR) > diffFrac * width);
      if (bad) {
        const mx = (pL[0] + pR[0]) / 2, my = (pL[1] + pR[1]) / 2;
        out.push([p[0] + nudge * (mx - p[0]), p[1] + nudge * (my - p[1])]);
      } else {
        out.push(p);
      }
    }
    pts = out;
  }
  return smooth(pts, closed, 1);
}

// ----------------------------------------------------------------- slalom snap
function slalomGroups(centers, width) {
  const un = centers.slice();
  const groups = [];
  while (un.length) {
    const g = [un.shift()];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = un.length - 1; i >= 0; i--) {
        const p = un[i];
        if (Math.min(...g.map((q) => dist(p, q))) < 2.3 * width) { g.push(p); un.splice(i, 1); grew = true; }
      }
    }
    const o = [g[0]];
    const rem = g.slice(1);
    while (rem.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < rem.length; i++) {
        const d = dist(o[o.length - 1], rem[i]);
        if (d < bd) { bd = d; bi = i; }
      }
      o.push(rem[bi]);
      rem.splice(bi, 1);
    }
    groups.push(o);
  }
  return groups;
}

// Centripetal Catmull-Rom (alpha = 0.5) through `pts`, sampled into ~N points.
// Replaces scipy splprep/splev for the slalom pass: interpolating rather than
// smoothing, but C1-continuous and passes next to the (high-weight) cones.
function catmullRom(pts, N) {
  const m = pts.length;
  if (m < 3) return pts.slice();
  const pad = [pts[0], ...pts, pts[m - 1]];
  let total = 0;
  const segLen = [];
  for (let i = 0; i < m - 1; i++) { const d = dist(pts[i], pts[i + 1]); segLen.push(d); total += d; }
  if (total < 1e-9) return pts.slice();

  const lerpT = (a, b, ta, tb, t) => {
    if (tb - ta < 1e-9) return [a[0], a[1]];
    const f = (t - ta) / (tb - ta);
    return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
  };
  const seg = (p0, p1, p2, p3, t) => {
    const tj = (ti, pa, pb) => ti + Math.pow(Math.hypot(pb[0] - pa[0], pb[1] - pa[1]), 0.5);
    const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
    const T = t1 + (t2 - t1) * t;
    const A1 = lerpT(p0, p1, t0, t1, T);
    const A2 = lerpT(p1, p2, t1, t2, T);
    const A3 = lerpT(p2, p3, t2, t3, T);
    const B1 = lerpT(A1, A2, t0, t2, T);
    const B2 = lerpT(A2, A3, t1, t3, T);
    return lerpT(B1, B2, t1, t2, T);
  };

  const out = [];
  for (let i = 0; i < m - 1; i++) {
    const steps = Math.max(2, Math.round(N * (segLen[i] / total)));
    for (let s = 0; s < steps; s++) out.push(seg(pad[i], pad[i + 1], pad[i + 2], pad[i + 3], s / steps));
  }
  out.push(pts[m - 1]);
  return out;
}

function snapSlaloms(sk, closed, centers, width) {
  if (!centers.length || !closed) return sk;
  let pts = sk.slice(0, -1);
  let n = pts.length;
  const K = 9;
  for (const g of slalomGroups(centers, width)) {
    let i0 = 0, d0 = Infinity, i1 = 0, d1 = Infinity;
    for (let i = 0; i < n; i++) {
      const da = dist(pts[i], g[0]);
      if (da < d0) { d0 = da; i0 = i; }
      const db = dist(pts[i], g[g.length - 1]);
      if (db < d1) { d1 = db; i1 = i; }
    }
    const a = Math.min(i0, i1), b = Math.max(i0, i1);
    if (a === b || (b - a) > Math.floor(n / 2)) continue;
    const segCones = dist(pts[a], g[0]) < dist(pts[a], g[g.length - 1]) ? g : g.slice().reverse();
    const pre = pts.slice(Math.max(0, a - K), a + 1);
    const post = pts.slice(b, b + K + 1);
    const anchors = pre.concat(segCones, post);
    const ded = [anchors[0]];
    for (let i = 1; i < anchors.length; i++) {
      if (dist(anchors[i], ded[ded.length - 1]) > 0.4) ded.push(anchors[i]);
    }
    if (ded.length < 4) continue;
    let length = 0;
    for (let i = 0; i < ded.length - 1; i++) length += dist(ded[i], ded[i + 1]);
    const newseg = catmullRom(ded, Math.max(4, Math.round(length)));
    pts = pts.slice(0, Math.max(0, a - K)).concat(newseg, pts.slice(b + K + 1));
    n = pts.length;
  }
  pts.push(pts[0]);
  return pts;
}

// ----------------------------------------------------------------- public API
/**
 * Compute a track centerline from cone positions.
 * @param {Array<{lat:number,lng:number,side:'left'|'right'|'center'}>} cones
 * @param {{step?:number}} [opts]  step = point spacing in metres (default 1.0)
 * @returns {{ok:true,closed:boolean,length:number,points:Array<{lat,lng,width}>}
 *          | {ok:false,reason:string}}
 */
export function computeCenterline(cones, opts = {}) {
  const step = opts.step ?? 1.0;
  if (!Array.isArray(cones) || cones.length < 6) {
    return { ok: false, reason: "need at least 3 left and 3 right cones" };
  }
  const { P, back } = project(cones);

  const left = [], right = [], centers = [];
  let firstRight = null;
  for (let i = 0; i < cones.length; i++) {
    const xy = P[i];
    if (cones[i].side === "left") left.push(xy);
    else if (cones[i].side === "right") { right.push(xy); if (!firstRight) firstRight = xy; }
    else if (cones[i].side === "center") centers.push(xy);
  }
  if (left.length < 3 || right.length < 3) {
    return { ok: false, reason: "need at least 3 left and 3 right cones" };
  }

  // auto track width: median nearest left->right distance
  const widths0 = left.map((p) => nearestDist(p, right)).sort((a, b) => a - b);
  const width = widths0[Math.floor(widths0.length / 2)];
  if (!(width > 0)) return { ok: false, reason: "degenerate cone geometry" };

  // wall cones for the medial graph (left = 0, right = 1)
  const Pw = [], S = [];
  for (let i = 0; i < cones.length; i++) {
    if (cones[i].side === "left") { Pw.push(P[i]); S.push(0); }
    else if (cones[i].side === "right") { Pw.push(P[i]); S.push(1); }
  }

  const chains = medialChains(Pw, S, width, centers);
  if (!chains.length) return { ok: false, reason: "no centerline found — check cone sides" };

  const route = heldKarpTour(chains);
  const { loop, closed } = buildLoop(route, left, right, centers, width);

  let sk = smooth(resample(loop, step, closed), closed, 1);
  sk = clampInside(sk, closed, left, right, width);
  sk = snapSlaloms(sk, closed, centers, width);
  sk = smooth(resample(sk, step, closed), closed, 1);
  sk = clampInside(sk, closed, left, right, width, 0.50, 0.35, 0.5, 6);
  sk = smooth(resample(sk, step, closed), closed, 1);

  // Rotate a closed loop so it starts near the start gate (first cone + first right cone).
  if (closed && sk.length > 3 && firstRight) {
    const L0 = P[0], R0 = firstRight;
    const gate = [(L0[0] + R0[0]) / 2, (L0[1] + R0[1]) / 2];
    let si = 0, sd = Infinity;
    for (let i = 0; i < sk.length - 1; i++) {
      const d = dist(sk[i], gate);
      if (d < sd) { sd = d; si = i; }
    }
    sk = sk.slice(si, -1).concat(sk.slice(0, si));
    sk.push(sk[0]);
  }

  let length = 0;
  for (let i = 0; i < sk.length - 1; i++) length += dist(sk[i], sk[i + 1]);

  const points = sk.map((xy) => {
    const [lat, lng] = back(xy[0], xy[1]);
    return { lat, lng };
  });

  return { ok: true, closed, length, points };
}

/**
 * Convert a computeCenterline result to a GeoJSON LineString Feature — the
 * reusable export surface (e.g. for a future Assetto Corsa line export).
 */
export function centerlineToGeoJSON(result, { name = "course" } = {}) {
  if (!result || !result.ok) return null;
  return {
    type: "Feature",
    properties: { name, closed: result.closed, length_m: Math.round(result.length * 10) / 10 },
    geometry: { type: "LineString", coordinates: result.points.map((p) => [p.lng, p.lat]) },
  };
}
