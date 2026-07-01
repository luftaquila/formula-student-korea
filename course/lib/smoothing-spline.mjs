// Reinsch weighted cubic smoothing spline — dependency-free, isomorphic.
//
// This is the smoothing-spline replacement for scipy's FITPACK splprep used by
// the centerline slalom pass. It is the SAME CLASS of estimator as splprep (a
// penalised cubic smoothing spline that SMOOTHS rather than interpolates), so it
// suppresses the small kinks/"삐침" a Catmull-Rom interpolation leaves — but it
// is a Reinsch natural-spline formulation, not a byte-identical FITPACK port
// (no JS port of FITPACK exists; JS spline libraries only interpolate).
//
// Formulation (Green & Silverman, "Nonparametric Regression", 1994):
//   knots u_0<...<u_{n-1}, values y, fit weights W=diag(w_i^2).
//   Q (n×(n-2)) second-difference operator, R ((n-2)×(n-2)) tridiagonal.
//   Minimising (y-g)ᵀW(y-g) + α·gᵀ Q R⁻¹ Qᵀ g gives
//       (R + α QᵀW⁻¹Q) γ = Qᵀ y ,   g = y − α W⁻¹ Q γ .
//   γ are the interior second derivatives; endpoints are natural (g''=0), so
//   (u_i, g_i, γ) defines a natural cubic spline that reproduces the fit.
//
// The smoothing amount is set FITPACK-style: choose α so the weighted residual
//   fp = Σ_i w_i²·‖y_i − g_i‖² == s     (splprep's s semantics),
// found by bisection on α (fp is monotone increasing in α, 0 → linear fit).

// Solve A·X = B for one or more RHS columns. A is n×n (array of row arrays),
// B is n×k (array of row arrays). Gaussian elimination with partial pivoting;
// n is tiny (a few dozen knots) so an O(n³) dense solve is more than adequate.
function solveDense(A, B) {
  const n = A.length;
  const k = B[0].length;
  const M = A.map((row, i) => row.slice().concat(B[i].slice())); // augmented n×(n+k)
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) { best = v; piv = r; }
    }
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    const diag = M[col][col] || 1e-300;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / diag;
      if (f === 0) continue;
      for (let c = col; c < n + k; c++) M[r][c] -= f * M[col][c];
    }
  }
  const X = [];
  for (let i = 0; i < n; i++) {
    const diag = M[i][i] || 1e-300;
    const row = [];
    for (let c = 0; c < k; c++) row.push(M[i][n + c] / diag);
    X.push(row);
  }
  return X; // n×k
}

// Build the Green-Silverman Q (n×m) and R (m×m) operators, m=n-2.
function buildQR(u) {
  const n = u.length;
  const m = n - 2;
  const h = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) h[i] = u[i + 1] - u[i];
  const Q = Array.from({ length: n }, () => new Array(m).fill(0));
  const R = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let c = 0; c < m; c++) {
    const kk = c + 1;               // interior knot index
    Q[kk - 1][c] = 1 / h[kk - 1];
    Q[kk][c] = -1 / h[kk - 1] - 1 / h[kk];
    Q[kk + 1][c] = 1 / h[kk];
    R[c][c] = (h[kk - 1] + h[kk]) / 3;
    if (c + 1 < m) { R[c][c + 1] = h[kk] / 6; R[c + 1][c] = h[kk] / 6; }
  }
  return { Q, R, h };
}

/**
 * Fit a weighted cubic smoothing spline to columns of ordinates sharing knots u.
 * @param {number[]} u strictly increasing knot parameters
 * @param {number[][]} cols one array of values per output dimension (e.g. [xs, ys])
 * @param {number[]} w per-knot weights (higher = fit tighter here)
 * @param {number} s target weighted residual Σ w_i²·‖y_i−g_i‖² (splprep's s)
 * @returns {{gs:number[][], dds:number[][]}} smoothed values + full 2nd-derivatives
 */
export function reinschFit(u, cols, w, s) {
  const n = u.length;
  if (n < 3) return { gs: cols.map((c) => c.slice()), dds: cols.map(() => new Array(n).fill(0)) };
  const m = n - 2;
  const { Q, R } = buildQR(u);
  const winv = w.map((wi) => 1 / (wi * wi));

  // QtWinvQ (m×m) and Qty per column (m each), precomputed once.
  const QtWinvQ = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let a = 0; a < m; a++) {
    for (let b = 0; b < m; b++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Q[i][a] * winv[i] * Q[i][b];
      QtWinvQ[a][b] = sum;
    }
  }
  const Qty = cols.map((col) => {
    const out = new Array(m).fill(0);
    for (let a = 0; a < m; a++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Q[i][a] * col[i];
      out[a] = sum;
    }
    return out;
  });

  // Solve for a given α; return smoothed columns, interior γ per column, and fp.
  const solveAlpha = (alpha) => {
    const M = R.map((row, a) => row.map((v, b) => v + alpha * QtWinvQ[a][b]));
    const B = [];
    for (let a = 0; a < m; a++) B.push(Qty.map((q) => q[a])); // m×ncol
    const G = solveDense(M, B); // m×ncol -> γ per column
    const gammas = cols.map((_, ci) => G.map((row) => row[ci]));
    const gs = cols.map((col, ci) => {
      const gamma = gammas[ci];
      const g = new Array(n);
      for (let i = 0; i < n; i++) {
        // (Q γ)_i
        let qg = 0;
        for (let a = 0; a < m; a++) qg += Q[i][a] * gamma[a];
        g[i] = col[i] - alpha * winv[i] * qg;
      }
      return g;
    });
    let fp = 0;
    for (let i = 0; i < n; i++) {
      let r2 = 0;
      for (let ci = 0; ci < cols.length; ci++) { const d = cols[ci][i] - gs[ci][i]; r2 += d * d; }
      fp += w[i] * w[i] * r2;
    }
    return { gs, gammas, fp };
  };

  let chosen;
  if (s <= 0) {
    chosen = solveAlpha(0); // interpolation
  } else {
    // grow α until fp >= s (or fp plateaus at the linear-fit residual)
    let hi = 1e-3;
    let solHi = solveAlpha(hi);
    let guard = 0;
    while (solHi.fp < s && guard < 60) { hi *= 4; solHi = solveAlpha(hi); guard++; }
    if (solHi.fp <= s) {
      chosen = solHi; // s exceeds the linear-fit residual -> use the smoothest fit
    } else {
      let lo = 0, hiA = hi;
      for (let it = 0; it < 80; it++) {
        const mid = 0.5 * (lo + hiA);
        const sol = solveAlpha(mid);
        if (sol.fp < s) lo = mid; else hiA = mid;
        chosen = sol;
      }
    }
  }

  const dds = chosen.gammas.map((gamma) => {
    const dd = new Array(n).fill(0);
    for (let k = 0; k < m; k++) dd[k + 1] = gamma[k];
    return dd;
  });
  return { gs: chosen.gs, dds };
}

// Evaluate a natural cubic spline (u, g, dd) at parameter t (clamped to range).
function evalSpline(u, g, dd, t) {
  const n = u.length;
  if (t <= u[0]) t = u[0];
  else if (t >= u[n - 1]) t = u[n - 1];
  let i = 0;
  // linear scan is fine (n small); find segment [u_i, u_{i+1}]
  while (i < n - 2 && u[i + 1] < t) i++;
  const h = u[i + 1] - u[i] || 1e-12;
  const A = (u[i + 1] - t) / h;
  const B = (t - u[i]) / h;
  return A * g[i] + B * g[i + 1] +
    ((A * A * A - A) * dd[i] + (B * B * B - B) * dd[i + 1]) * (h * h) / 6;
}

/**
 * Parametric smoothing-spline fit + resample (splprep/splev replacement).
 * @param {number[][]} points anchor points [[x,y],...] (deduplicated, ordered)
 * @param {number[]} weights per-anchor weights (cones weighted high)
 * @param {number} s target residual (Python uses points.length * 1.5)
 * @param {number} nOut number of resampled points to emit (>=2)
 * @returns {number[][]} resampled [[x,y],...]
 */
export function fitParametric(points, weights, s, nOut) {
  const n = points.length;
  if (n < 3 || nOut < 2) return points.map((p) => p.slice());

  // normalized cumulative chord-length parameter u ∈ [0,1] (matches splprep)
  const v = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    v[i] = v[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  const total = v[n - 1];
  if (!(total > 0)) return points.map((p) => p.slice());
  const u = v.map((x) => x / total);

  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const { gs, dds } = reinschFit(u, [xs, ys], weights, s);

  const out = [];
  for (let k = 0; k < nOut; k++) {
    const t = k / (nOut - 1);
    out.push([evalSpline(u, gs[0], dds[0], t), evalSpline(u, gs[1], dds[1], t)]);
  }
  return out;
}
