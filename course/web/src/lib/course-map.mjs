import L from "leaflet";

export async function createCourseBaseMap(element, options = {}) {
  // leaflet-rotate patches the global Leaflet object when its UMD bundle loads.
  globalThis.L = L;
  await import("leaflet-rotate");
  const map = L.map(element, {
    preferCanvas: true, zoomControl: true, maxZoom: 21, boxZoom: false,
    rotate: true, rotateControl: false, touchRotate: false,
    ...options,
  }).setView([35.292012, 126.574415], 19);
  // Basemap. VWorld satellite when a key is configured (window.__VWORLD_KEY__,
  // injected at container start by entrypoint.sh from $VWORLD_KEY). VWorld's
  // imagery is georeferenced to the Korean national datum, so RTK WGS84 points
  // land where they actually are — Google's Korea satellite tiles are offset
  // several meters. Falls back to Google where no key is set (local dev,
  // production) so those environments stay unchanged.
  // VWorld tiles top out at native zoom 19; maxNativeZoom upscales 19→21 so the
  // map's 21 max stays usable (blurry past 19, but no blank tiles).
  const vworldKey = window.__VWORLD_KEY__;
  if (vworldKey) {
    L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${vworldKey}/Satellite/{z}/{y}/{x}.jpeg`, {
      attribution: "&copy; VWorld", maxNativeZoom: 19, maxZoom: 21,
    }).addTo(map);
    // Transparent road/place-label overlay, matching Google hybrid's labels.
    L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${vworldKey}/Hybrid/{z}/{y}/{x}.png`, {
      attribution: "&copy; VWorld", maxNativeZoom: 19, maxZoom: 21,
    }).addTo(map);
  } else {
    L.tileLayer("https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&scale=2", {
      subdomains: "0123", attribution: "&copy; Google", maxZoom: 21,
    }).addTo(map);
  }

  return map;
}

export function courseCenterlineLayer(centerline) {
  const pts = centerline.points;
  const latlngs = pts.map((p) => [p.lat, p.lng]);
  // Dark casing under a light dashed line so the centerline reads over satellite tiles.
  const guided = !!centerline.metric?.routeNodeIds;
  const layers = [
    L.polyline(latlngs, { color: "#0b1021", weight: 5, opacity: 0.45, interactive: false }),
    L.polyline(latlngs, {
      color: guided ? "#34d399" : "#f8fafc",
      weight: 2.5,
      opacity: 0.95,
      dashArray: "7 6",
      interactive: false,
    }),
  ];
  const arrow = startArrow(pts);
  if (arrow) layers.push(...arrow);
  return L.layerGroup(layers);
}

// Start marker + a travel-direction arrow at points[0], drawn in geographic
// coordinates (metres → lat/lng) so it scales and rotates with the map. The
// heading is taken a few points ahead for stability; flips with reverse.
function startArrow(pts) {
  if (!pts || pts.length < 3) return null;
  const a = pts[0];
  const b = pts[Math.min(6, pts.length - 1)];
  const latRad = (a.lat * Math.PI) / 180;
  const mLat = 110540, mLng = 111320 * Math.cos(latRad);
  let fe = (b.lng - a.lng) * mLng, fn = (b.lat - a.lat) * mLat;   // forward (east, north) metres
  const fm = Math.hypot(fe, fn);
  if (fm < 1e-6) return null;
  fe /= fm; fn /= fm;
  const toLL = (em, nm) => [a.lat + nm / mLat, a.lng + em / mLng];
  const pe = -fn, pn = fe;                                        // left-perpendicular unit
  // ONE arrow polygon (shaft + head): a single continuous outline, so there is
  // no seam between the stem and the triangle and no stem poking past the tip.
  const HEAD = 7, HEADLEN = 3.2, HW = 1.5, SW = 0.55;            // metres: tip dist, head length, head/shaft half-width
  const B = HEAD - HEADLEN;                                       // head base distance from start
  const pt = (along, off) => toLL(along * fe + off * pe, along * fn + off * pn);
  const arrow = [pt(0, SW), pt(B, SW), pt(B, HW), pt(HEAD, 0), pt(B, -HW), pt(B, -SW), pt(0, -SW)];
  const C = "#2fe36a";                                            // bright green
  const EDGE = "#0b1021";                                         // dark casing so it reads on any basemap
  return [
    L.polygon(arrow, { color: EDGE, weight: 2, lineJoin: "round", fillColor: C, fillOpacity: 1, interactive: false }),
    // start dot in METRES (like the shaft) with radius = shaft half-width, so it
    // is exactly as wide as the stem at every zoom (a pixel circleMarker wasn't).
    L.circle([a.lat, a.lng], { radius: SW, color: EDGE, weight: 2, fillColor: C, fillOpacity: 1, interactive: false }),
  ];
}
