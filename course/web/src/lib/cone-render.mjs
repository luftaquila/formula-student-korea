// Cone rendering primitives extracted from MapView.vue: the side→colour map, the
// DOM cone-icon HTML, the Leaflet divIcon factories, the zoom→size curve, and the
// label-painting canvas renderer. All pure/stateless (no Vue refs) — they take
// plain args and return Leaflet objects/strings, so they're reusable and testable.
// The ref-coupled `coneCircle` (reads the current selection) stays in MapView and
// imports these.
import L from "leaflet";

export const SIDE_COLORS = { left: "#f59e0b", right: "#06b6d4", center: "#ef4444" };

// No box-shadow/text-shadow on cone icons — they cause mobile pan jank with
// dozens of markers (each becomes its own GPU compositing layer).
// The dot sizes off the --cone-px CSS variable (set on the map container per
// zoom level, see applyConeScale), so cones shrink when zoomed out instead of
// staying a fixed pixel size that blankets the map. A fixed 26px wrapper keeps
// the dot centred on the cone's latlng regardless of the inner size.
export function coneDot(side, num, borderColor, borderRatio, opacity) {
  // content-box + a border that scales with --cone-px, so a fixed-thickness
  // outline never eats the number when the dot is small (zoomed out).
  const border = `max(1px, calc(var(--cone-px,18px) * ${borderRatio}))`;
  return `<div style="opacity:${opacity};width:100%;height:100%;display:flex;align-items:center;justify-content:center;"><div style="box-sizing:content-box;width:var(--cone-px,18px);height:var(--cone-px,18px);border-radius:50%;background:${SIDE_COLORS[side]};border:${border} solid ${borderColor};display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:calc(var(--cone-px,18px)*0.5);font-weight:700;line-height:1;">${num}</span></div></div>`;
}
export function coneIcon(side, num, active) {
  return L.divIcon({ className: "", html: coneDot(side, num, "#fff", 0.1, active ? 1 : 0.45), iconSize: [26, 26], iconAnchor: [13, 13] });
}

export function highlightIcon(side, num) {
  return L.divIcon({ className: "", html: coneDot(side, num, "#fbbf24", 0.16, 1), iconSize: [26, 26], iconAnchor: [13, 13] });
}

export function multiSelectIcon(side, num) {
  return L.divIcon({ className: "", html: coneDot(side, num, "#38bdf8", 0.16, 1), iconSize: [26, 26], iconAnchor: [13, 13] });
}

// Canvas renderer that also paints each circleMarker's `label` (the cone's
// side index) in the centre — so non-editing tabs keep the numbers while still
// drawing hundreds of cones in a single canvas pass instead of hundreds of DOM
// nodes. Overrides L.Canvas._updateCircle (Leaflet 1.9), drawing the number
// right after the base circle while the layer's canvas point is current.
const CONE_MIN_R = 2.5, CONE_MAX_R = 9; // dot radius (px), scaled by zoom
// A Leaflet circleMarker is a fixed pixel size, so when you zoom out the dots
// stay 9px and pack into a solid blanket that hides the map. Scale the radius
// with zoom (≈halving per zoom level out) so dots stay roughly proportional to
// cone spacing, and clamp to a sane range.
export function coneRadiusForZoom(zoom) {
  return Math.max(CONE_MIN_R, Math.min(CONE_MAX_R, CONE_MAX_R * Math.pow(2, zoom - 20)));
}
// DOM cone-icon diameter (courses tab) — same zoom curve as the canvas dots.
export function coneDiameterForZoom(zoom) {
  return 2 * coneRadiusForZoom(zoom);
}
// Draw each cone pixel-identical to the courses-tab DOM marker (coneDot): a
// coloured disc of radius r, a white ring of thickness max(1px, diameter*0.1)
// sitting OUTSIDE it (the DOM uses a content-box border), and a centred number
// at font = 0.5*diameter in the app font. All on one shared canvas so the
// non-editing tabs stay smooth with hundreds of cones.
// The courses-tab DOM cone number inherits Leaflet's `.leaflet-container` font,
// not the app body font — so the canvas labels must use the SAME stack to look
// identical. (Verified at runtime: the DOM cone computes to this family, and the
// canvas cannot render the app's Noto Sans KR web font, so reusing that would
// diverge.) Match Leaflet's default exactly.
const CONE_FONT = `"Helvetica Neue", Arial, Helvetica, sans-serif`;
export const LabeledConeCanvas = L.Canvas.extend({
  _updateCircle(layer) {
    const r = coneRadiusForZoom(this._map.getZoom());
    layer._radius = r;
    // No centred stroke — the base call paints only the coloured fill (radius r);
    // we add the white ring OUTSIDE it below to mirror the DOM's content-box border.
    layer.options.weight = 0;
    L.Canvas.prototype._updateCircle.call(this, layer);
    if (!this._drawing || layer._empty()) return;
    const p = layer._point, ctx = this._ctx;
    // Ring thickness/colour mirror the DOM cone: white at ratio 0.1 by default,
    // but a selected/multi-selected cone on the locked courses tab gets the same
    // amber/sky highlight ring the DOM markers use (set via coneCircle options).
    const ratio = layer.options.ringRatio ?? 0.1;
    const border = Math.max(1, 2 * r * ratio); // = DOM border: max(1px, --cone-px*ratio)
    ctx.save();
    ctx.globalAlpha = layer.options.opacity ?? 1;
    // Border ring, just outside the coloured fill (so the fill stays a full
    // radius r, exactly like the DOM circle whose border is added outside it).
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + border / 2, 0, Math.PI * 2);
    ctx.lineWidth = border;
    ctx.strokeStyle = layer.options.ringColor || "#fff";
    ctx.stroke();
    // Centred number at the DOM font size/family. Counter-rotate by the current
    // bearing so it stays upright while the canvas pane is rotated.
    if (layer.options.label != null) {
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${r.toFixed(1)}px ${CONE_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.translate(p.x, p.y);
      ctx.rotate(-(this._map._bearing || 0));
      ctx.fillText(String(layer.options.label), 0, 0);
    }
    ctx.restore();
  },
});
