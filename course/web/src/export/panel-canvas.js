// Two-panel course preview PNG, rendered with a DOM <canvas>. This is the ONLY
// DOM-dependent piece of the export pipeline (everything else in shared/ is
// isomorphic and Node-tested); it is excluded from the byte-parity tests.
//
//   left panel  : centerline + cones (blue = geom-left, red = geom-right, green = center)
//   right panel : filled road ribbon + left/right edges + centerline + cones
// Both panels share one equal-aspect world scale. Mirrors draw_width.py's render.

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/**
 * @param {object} cl    computeCenterline result with `.metric`
 * @param {object} edges buildRoadEdges result
 * @param {{name?:string}} [opts]
 * @returns {Promise<Blob>} PNG blob
 */
export function renderTwoPanelPNG(cl, edges, { name = "course" } = {}) {
  const P = cl.metric.P;
  const left = cl.metric.left, right = cl.metric.right, centers = cl.metric.centers;
  const { Le, Re, width } = edges;

  // world bounds over everything drawn
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const arr of [P, left, right, centers, Le, Re]) {
    for (const p of arr) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);

  // layout
  const titleH = 42, pad = 22, gap = 28;
  const contentH = 680;
  const contentW = Math.max(240, Math.min(1100, contentH * (spanX / spanY)));
  const panelW = contentW + 2 * pad;
  const panelH = contentH + titleH + 2 * pad;
  const W = panelW * 2 + gap, H = panelH;

  const scale = Math.min(contentW / spanX, contentH / spanY);
  const drawnW = spanX * scale, drawnH = spanY * scale;
  const project = (originX) => (x, y) => [
    originX + pad + (contentW - drawnW) / 2 + (x - minX) * scale,
    titleH + pad + (contentH - drawnH) / 2 + (drawnH - (y - minY) * scale),   // flip Y (north up)
  ];

  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.font = "15px system-ui, -apple-system, 'Apple SD Gothic Neo', sans-serif";
  ctx.textBaseline = "middle";

  const polyline = (proj, pts, style, lw, closed) => {
    if (!pts.length) return;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const [px, py] = proj(pts[i][0], pts[i][1]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    if (closed) ctx.closePath();
    ctx.strokeStyle = style; ctx.lineWidth = lw; ctx.lineJoin = "round"; ctx.stroke();
  };
  const scatter = (proj, pts, color, r) => {
    ctx.fillStyle = color;
    for (const p of pts) {
      const [px, py] = proj(p[0], p[1]);
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
  };
  const ribbon = (proj) => {
    if (!Le.length) return;
    ctx.beginPath();
    const ring = Le.concat(Re.slice().reverse());
    for (let i = 0; i < ring.length; i++) {
      const [px, py] = proj(ring[i][0], ring[i][1]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(150,150,150,0.40)"; ctx.fill();
  };
  const cones = (proj) => {
    scatter(proj, left, "#1f4fd0", 3.2);
    scatter(proj, right, "#d02020", 3.2);
    scatter(proj, centers, "#1a9c3c", 4.5);
  };
  const title = (originX, text) => {
    ctx.fillStyle = "#111"; ctx.textAlign = "center";
    ctx.fillText(text, originX + panelW / 2, titleH / 2 + pad / 2);
    ctx.textAlign = "left";
  };

  // left panel — centerline
  const projL = project(0);
  polyline(projL, P, "#111", 1.4, cl.closed);
  cones(projL);
  title(0, `${name} — 중심선 (${cl.length.toFixed(0)} m)`);

  // right panel — road width
  const originR = panelW + gap;
  const projR = project(originR);
  ribbon(projR);
  polyline(projR, Le, "#182a6e", 1.6, cl.closed);
  polyline(projR, Re, "#7a1414", 1.6, cl.closed);
  polyline(projR, P, "#111", 1.0, cl.closed);
  cones(projR);
  title(originR, `도로폭 (median ${median(width).toFixed(2)} m, min ${Math.min(...width).toFixed(2)} m)`);

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}
