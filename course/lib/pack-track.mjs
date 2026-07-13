// Package a built track model into an Assetto Corsa track folder tree —
// dependency-free port of pack_track.py. Returns a { path -> bytes|string } map
// rooted at content/tracks/<name>/ so it extracts into the AC root directly; the
// caller does the actual zipping (JSZip in the browser). Minimap/outline/preview
// PNGs are rasterised with the tiny isomorphic png.mjs (no node-canvas).

import { encodePNG } from "./png.mjs";

// data/surfaces.ini — static (byte-identical to pack_track.py).
const SURFACES_INI = `[SURFACE_0]
KEY=ROAD
FRICTION=0.99
DAMPING=0
WAV=
WAV_PITCH=0
FF_EFFECT=1
DIRT_ADDITIVE=0
IS_VALID_TRACK=1
BLACK_FLAG_TIME=0
SIN_HEIGHT=0
SIN_LENGTH=0
IS_PITLANE=0
VIBRATION_GAIN=0
VIBRATION_LENGTH=0

[SURFACE_1]
KEY=GRASS
FRICTION=0.7
DAMPING=0.1
WAV=
WAV_PITCH=0
FF_EFFECT=0
DIRT_ADDITIVE=0.4
IS_VALID_TRACK=0
BLACK_FLAG_TIME=0
SIN_HEIGHT=0.02
SIN_LENGTH=1
IS_PITLANE=0
VIBRATION_GAIN=0.2
VIBRATION_LENGTH=1.5
`;

// world (x_e, y_n) -> AC map plane (X, Z) = (x_e, -y_n)
const acXZ = (edge) => edge.map(([x, y]) => [x, -y]);

// Python %g (strip trailing zeros / dot) at `p` significant digits.
function gfmt(x, p = 6) {
  if (x === 0) return "0";
  let s = x.toPrecision(p);
  if (s.indexOf("e") < 0 && s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
  return s;
}

// ---- tiny RGBA raster helpers (PNGs are not byte-compared) ------------------
function setPx(img, w, x, y, c) {
  const i = (y * w + x) * 4;
  img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; img[i + 3] = c[3];
}

function fillPolygon(img, w, h, pts, color) {
  let ymin = Infinity, ymax = -Infinity;
  for (const p of pts) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
  ymin = Math.max(0, Math.floor(ymin));
  ymax = Math.min(h - 1, Math.ceil(ymax));
  for (let y = ymin; y <= ymax; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const y0 = a[1], y1 = b[1];
      if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc)) {
        xs.push(a[0] + ((yc - y0) / (y1 - y0)) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.round(xs[k]));
      const xb = Math.min(w - 1, Math.round(xs[k + 1]));
      for (let x = xa; x <= xb; x++) setPx(img, w, x, y, color);
    }
  }
}

function drawLine(img, w, h, a, b, color) {
  let x0 = Math.round(a[0]), y0 = Math.round(a[1]);
  const x1 = Math.round(b[0]), y1 = Math.round(b[1]);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (x0 >= 0 && x0 < w && y0 >= 0 && y0 < h) setPx(img, w, x0, y0, color);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function strokePolygon(img, w, h, pts, color) {
  for (let i = 0; i < pts.length; i++) drawLine(img, w, h, pts[i], pts[(i + 1) % pts.length], color);
}

function ringBounds(ring) {
  let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
  for (const [x, z] of ring) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  return { minx, minz, maxx, maxz };
}

// map.png + map.ini (AC minimap transform: pixel=(world+OFFSET)*SCALE, SCALE=1).
function makeMap(Le, Re, margin = 20, maxSize = 1600) {
  const ring = acXZ(Le).concat(acXZ(Re).slice().reverse());
  const { minx, minz, maxx, maxz } = ringBounds(ring);
  const spanx = maxx - minx, spanz = maxz - minz;
  let scale = 1.0;
  if (Math.max(spanx, spanz) + 2 * margin > maxSize) scale = (maxSize - 2 * margin) / Math.max(spanx, spanz);
  const xOff = margin / scale - minx;
  const zOff = margin / scale - minz;
  const W = spanx * scale + 2 * margin, H = spanz * scale + 2 * margin;
  const Wpx = Math.round(W), Hpx = Math.round(H);
  const toPx = (p) => [(p[0] + xOff) * scale, (p[1] + zOff) * scale];
  const img = new Uint8Array(Wpx * Hpx * 4);          // transparent
  fillPolygon(img, Wpx, Hpx, ring.map(toPx), [255, 255, 255, 255]);
  const png = encodePNG(Wpx, Hpx, img);
  const ini =
    "[PARAMETERS]\n" +
    `WIDTH=${W.toFixed(3)}\nHEIGHT=${H.toFixed(3)}\nMARGIN=${margin}\n` +
    `SCALE_FACTOR=${gfmt(scale, 6)}\nMAX_SIZE=${maxSize}\n` +
    `X_OFFSET=${xOff.toFixed(6)}\nZ_OFFSET=${zOff.toFixed(6)}\nDRAWING_SIZE=10\n`;
  return { png, ini };
}

function makeOutline(Le, Re, size = 512, margin = 12) {
  const ring = acXZ(Le).concat(acXZ(Re).slice().reverse());
  const { minx, minz, maxx, maxz } = ringBounds(ring);
  const span = Math.max(maxx - minx, maxz - minz) || 1;
  const scale = (size - 2 * margin) / span;
  const img = new Uint8Array(size * size * 4);        // transparent
  const pts = ring.map((p) => [(p[0] - minx) * scale + margin, (p[1] - minz) * scale + margin]);
  fillPolygon(img, size, size, pts, [255, 255, 255, 60]);
  strokePolygon(img, size, size, pts, [255, 255, 255, 255]);
  return encodePNG(size, size, img);
}

function makePreview(Le, Re, w = 355, h = 200) {
  const ring = acXZ(Le).concat(acXZ(Re).slice().reverse());
  const { minx, minz, maxx, maxz } = ringBounds(ring);
  const m = 14;
  const scale = Math.min((w - 2 * m) / (maxx - minx || 1), (h - 2 * m) / (maxz - minz || 1));
  const ox = (w - (maxx - minx) * scale) / 2;
  const oz = (h - (maxz - minz) * scale) / 2;
  const img = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { img[i * 4] = 40; img[i * 4 + 1] = 44; img[i * 4 + 2] = 48; img[i * 4 + 3] = 255; }
  const pts = ring.map((p) => [(p[0] - minx) * scale + ox, (p[1] - minz) * scale + oz]);
  fillPolygon(img, w, h, pts, [70, 74, 78, 255]);
  strokePolygon(img, w, h, pts, [210, 210, 210, 255]);
  return encodePNG(w, h, img);
}

// Make a course name safe for file/folder paths: collapse whitespace runs to a
// single '-'. The in-game display name (ui_track.json) keeps the original.
export function safeTrackName(name) {
  // 이 값은 zip 엔트리 경로(content/tracks/<name>/...)에 그대로 들어가므로, 경로 구분자·상위
  // 참조(..)·예약 문자를 제거해 zip-slip(트랙 폴더 밖으로 추출)을 막는다. 공백은 '-'로,
  // 결과가 비면 'course'로 폴백. 게임 표시명(ui_track.json)은 원본을 유지한다.
  const cleaned = String(name)
    .replace(/[/\\]/g, "-")     // path separators
    .replace(/\.\.+/g, ".")      // collapse parent-traversal dots
    .replace(/[:*?"<>|]/g, "")   // filesystem-reserved chars
    .replace(/^\.+/, "")         // leading dots (hidden / relative)
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "course";
}

/**
 * Build the AC track folder tree.
 * @param {object} cl computeCenterline result (unused values kept for signature parity)
 * @param {object} edges buildRoadEdges result
 * @param {object} track buildTrackModel result ({kn5, ai, meta, edges})
 * @param {{name:string, uiName?:string}} opts  name = file/folder-safe base; uiName = display name
 * @returns {Object<string, (Uint8Array|string)>} path -> content
 */
export function packTrackEntries(cl, edges, track, opts = {}) {
  const name = opts.name || track.meta?.name || "course";   // file/folder-safe base
  const uiName = opts.uiName || name;                        // in-game display name (may contain spaces)
  const E = track.edges || edges;
  const Le = E.Le, Re = E.Re;
  const length = track.meta.length;
  const width = track.meta.medianWidth;

  const root = `content/tracks/${name}`;
  const { png: mapPng, ini: mapIni } = makeMap(Le, Re);

  const modelsIni = `[MODEL_0]\nFILE=${name}.kn5\nPOSITION=0,0,0\nROTATION=0,0,0\n`;

  const ui = {
    name: uiName,
    description: `Auto-generated from RTK GPS survey. Length ~${length.toFixed(0)} m, width ~${width.toFixed(1)} m.`,
    tags: ["circuit", "autogen", "cones"],
    geotags: [],
    country: "South Korea",
    city: "",
    length: `${length.toFixed(0)}`,
    width: `${width.toFixed(1)}`,
    pitboxes: "1",
    run: "clockwise",
    author: "luftaquila",
    version: "1.0",
    url: "https://github.com/luftaquila",
  };

  const entries = {};
  entries[`${root}/${name}.kn5`] = track.kn5;
  entries[`${root}/models.ini`] = modelsIni;
  entries[`${root}/data/surfaces.ini`] = SURFACES_INI;
  entries[`${root}/data/map.ini`] = mapIni;
  entries[`${root}/data/ideal_line.ai`] = track.ai;   // TimeAttack/Hotlap ideal-line ref
  entries[`${root}/ai/fast_lane.ai`] = track.ai;
  entries[`${root}/map.png`] = mapPng;
  entries[`${root}/ui/ui_track.json`] = JSON.stringify(ui, null, 2);
  entries[`${root}/ui/outline.png`] = makeOutline(Le, Re);
  entries[`${root}/ui/preview.png`] = makePreview(Le, Re);
  return entries;
}

export { SURFACES_INI };
