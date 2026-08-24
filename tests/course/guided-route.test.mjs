import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeGuidedRoute } from "../../course/lib/guided-route.mjs";
import { buildGuidedTrackModel } from "../../course/lib/guided-track-build.mjs";
import { packTrackEntries } from "../../course/lib/pack-track.mjs";
import { buildGuidedEnrichedJSON } from "../../course/lib/course-export.mjs";
import { readFastLane } from "../../course/lib/ai-line.mjs";
import { readKn5 } from "../../course/lib/kn5.mjs";
import { measuredSkidpadFixture } from "./fixtures/measured-skidpad.mjs";

const LAT0 = 35.292;
const LNG0 = 126.574;
const MLAT = 110540;
const MLNG = 111320 * Math.cos(LAT0 * Math.PI / 180);

function ll(x, y) {
  return { lat: LAT0 + y / MLAT, lng: LNG0 + x / MLNG };
}

function skidpadFixture() {
  const cones = [];
  const seen = new Set();
  const addCone = (x, y, side) => {
    const key = `${side}:${x.toFixed(4)}:${y.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    // A tilted surveyed plane verifies that both cones and pavement retain
    // elevation instead of being flattened in the guided branch.
    cones.push({ id: cones.length + 1, ...ll(x, y), alt: 100 + 0.04 * x + 0.06 * y, side });
  };
  const ring = (cx, radius, side, gapAngle) => {
    for (let i = 0; i < 48; i++) {
      const angle = 2 * Math.PI * i / 48;
      const wrapped = Math.atan2(Math.sin(angle - gapAngle), Math.cos(angle - gapAngle));
      if (Math.abs(wrapped) < Math.PI / 18) continue;
      addCone(cx + radius * Math.cos(angle), radius * Math.sin(angle), side);
    }
  };
  // Left loop is counter-clockwise (left wall inside); right loop is clockwise
  // (left wall outside). Both share the x=±1.5 m waist boundaries.
  ring(-12, 10.5, "left", 0);
  ring(-12, 13.5, "right", 0);
  ring(12, 13.5, "left", Math.PI);
  ring(12, 10.5, "right", Math.PI);
  for (const sign of [-1, 1]) {
    for (let y = 3; y <= 27; y += 3) {
      addCone(-1.5, sign * y, "left");
      addCone(1.5, sign * y, "right");
    }
  }

  const xy = [
    [0, -24, "진입"], [0, 0, "허리"],
    [-12, 12, "좌상"], [-24, 0, "좌외"], [-12, -12, "좌하"],
    [12, 12, "우상"], [24, 0, "우외"], [12, -12, "우하"],
    [0, 24, "진출"],
  ];
  const markers = xy.map(([x, y, label], i) => ({ id: i + 1, ...ll(x, y), label }));
  const [entry, waist, lt, lf, lb, rt, rf, rb, exit] = markers.map((m) => m.id);
  const steps = [
    entry, waist,
    lt, lf, lb, waist, lt, lf, lb, waist,
    rt, rf, rb, waist, rt, rf, rb, waist,
    exit,
  ];
  return { cones, markers, steps };
}

function maxTurnAngle(route) {
  let maxTurn = 0;
  for (let i = 1; i < route.metric.P.length - 1; i++) {
    const a = route.metric.P[i - 1], b = route.metric.P[i], c = route.metric.P[i + 1];
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    const cosine = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) || 1) * (Math.hypot(vx, vy) || 1));
    maxTurn = Math.max(maxTurn, Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI);
  }
  return maxTurn;
}

function windingTurns(route, center) {
  const c = [(center.lng - route.metric.lng0) * route.metric.mlng, (center.lat - route.metric.lat0) * route.metric.mlat];
  let previous = Math.atan2(route.metric.P[0][1] - c[1], route.metric.P[0][0] - c[0]);
  let total = 0;
  for (let i = 1; i < route.metric.P.length; i++) {
    const angle = Math.atan2(route.metric.P[i][1] - c[1], route.metric.P[i][0] - c[0]);
    let delta = angle - previous;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    total += delta;
    previous = angle;
  }
  return total / (2 * Math.PI);
}

describe("marker-guided skidpad route", () => {
  it("follows entry, left 2, right 2, and opposite exit with reusable markers", () => {
    const { cones, markers, steps } = skidpadFixture();
    const route = computeGuidedRoute(cones, markers, steps, { step: 1 });

    assert.equal(route.ok, true);
    assert.equal(route.closed, false);
    assert.ok(route.length > 300 && route.length < 430, `unexpected length ${route.length}`);
    assert.ok(route.metric.routeEdgeIds.length > route.metric.usedEdgeIds.length * 2);
    assert.equal(route.metric.steps.length, 19);
    assert.equal(route.points[0].lat < route.points.at(-1).lat, true);
    assert.ok(Math.max(...route.metric.z) - Math.min(...route.metric.z) > 2);
    let maxTurn = 0;
    for (let i = 1; i < route.metric.P.length - 1; i++) {
      const a = route.metric.P[i - 1], b = route.metric.P[i], c = route.metric.P[i + 1];
      const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
      const cosine = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) || 1) * (Math.hypot(vx, vy) || 1));
      maxTurn = Math.max(maxTurn, Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI);
    }
    assert.ok(maxTurn < 45, `centerline kink ${maxTurn}°`);
    for (const point of route.metric.P) {
      let clearance = -Infinity;
      for (const edgeId of route.metric.usedEdgeIds) {
        const edge = route.metric.graph.edges[edgeId];
        const a = route.metric.graph.nodes[edge.a], b = route.metric.graph.nodes[edge.b];
        const dx = b.point[0] - a.point[0], dy = b.point[1] - a.point[1], den = dx * dx + dy * dy;
        const t = den ? Math.max(0, Math.min(1, ((point[0] - a.point[0]) * dx + (point[1] - a.point[1]) * dy) / den)) : 0;
        const d = Math.hypot(point[0] - a.point[0] - t * dx, point[1] - a.point[1] - t * dy);
        clearance = Math.max(clearance, a.halfWidth + t * (b.halfWidth - a.halfWidth) - d);
      }
      assert.ok(clearance > 0.2, `smoothed route left surveyed pavement by ${clearance} m`);
    }
  });

  it("builds one elevation-aware physical surface and AC package for reused road", () => {
    const { cones, markers, steps } = skidpadFixture();
    const route = computeGuidedRoute(cones, markers, steps, { step: 1 });
    const track = buildGuidedTrackModel(route, cones, { name: "skidpad" });
    const entries = packTrackEntries(route, null, track, { name: "skidpad", uiName: "Skidpad" });
    const exported = buildGuidedEnrichedJSON({ name: "Skidpad", cones, route, track });
    const ai = readFastLane(track.ai);
    const kn5 = readKn5(track.kn5);

    assert.ok(track.kn5.length > 1000);
    assert.ok(track.ai.length > 1000);
    assert.ok(track.surface.vertices > 100 && track.surface.vertices <= 62000);
    assert.equal(track.mapGeometry.positions.length, track.surface.vertices);
    assert.ok(track.mapGeometry.positions.some((p) => Math.abs(p[1]) > 1));
    const roadHeightErrors = track.mapGeometry.positions.map(([x, z, acZ]) =>
      Math.abs(z - (100 + 0.04 * x + 0.06 * (-acZ) - route.metric.altitudeOffset))
    );
    const worstRoadIndex = roadHeightErrors.indexOf(Math.max(...roadHeightErrors));
    assert.ok(
      roadHeightErrors[worstRoadIndex] < 0.2,
      `road elevation error ${roadHeightErrors[worstRoadIndex]} at ${track.mapGeometry.positions[worstRoadIndex]}`,
    );
    assert.ok(entries["content/tracks/skidpad/skidpad.kn5"] instanceof Uint8Array);
    assert.ok(entries["content/tracks/skidpad/map.png"] instanceof Uint8Array);
    assert.deepEqual(exported.route_steps, steps.map((id) => id - 1));
    assert.equal(exported.route.step_count, 19);
    assert.equal(exported.elevation.present, true);
    assert.equal(ai.count, route.points.length);
    assert.equal(ai.leftover, 0);
    for (const [side, tag] of [["left", "L"], ["right", "R"]]) {
      const alts = cones.filter((cone) => cone.side === side).map((cone) => cone.alt - route.metric.altitudeOffset);
      const bounds = kn5.nodes.find((node) => node.name === `CONE_${tag}`).positionBounds;
      assert.ok(Math.abs(bounds.min[1] - Math.min(...alts)) < 1e-3);
      assert.ok(Math.abs(bounds.max[1] - (Math.max(...alts) + 0.3)) < 1e-3);
    }
  });

  it("rejects consecutive steps that collapse onto one graph station", () => {
    const { cones, markers } = skidpadFixture();
    const duplicate = { id: 99, ...markers[0], lat: markers[0].lat + 0.1 / MLAT };
    assert.throws(
      () => computeGuidedRoute(cones, [...markers, duplicate], [markers[0].id, duplicate.id]),
      /같은 그래프 지점/,
    );
  });

  it("reconstructs the measured 2026 skidpad as entry, left 2, right 2, and exit", () => {
    const { cones, markers, steps, centers } = measuredSkidpadFixture();
    const route = computeGuidedRoute(cones, markers, steps, { step: 0.5 });

    assert.equal(route.ok, true);
    assert.equal(route.closed, false);
    assert.equal(route.metric.steps.length, 19);
    assert.ok(route.length > 248 && route.length < 262, `unexpected measured route length ${route.length}`);
    assert.ok(maxTurnAngle(route) < 30, `measured centerline kink ${maxTurnAngle(route)}°`);
    assert.ok(route.metric.graph.edges.filter((edge) => edge.axisCorridor).length >= 10);
    assert.equal(route.metric.graph.edges.filter((edge) => edge.guidedBridge).length, 0);
    assert.ok(route.metric.routeEdgeIds.length > route.metric.usedEdgeIds.length * 2);

    const leftTurns = windingTurns(route, centers[0]);
    const rightTurns = windingTurns(route, centers[1]);
    assert.ok(leftTurns > 2.1 && leftTurns < 2.5, `left-circle turns ${leftTurns}`);
    assert.ok(rightTurns < -2.1 && rightTurns > -2.5, `right-circle turns ${rightTurns}`);

    const markerPoint = (marker) => [
      (marker.lng - route.metric.lng0) * route.metric.mlng,
      (marker.lat - route.metric.lat0) * route.metric.mlat,
    ];
    assert.ok(Math.hypot(...route.metric.P[0].map((value, i) => value - markerPoint(markers[0])[i])) < 1.2);
    assert.ok(Math.hypot(...route.metric.P.at(-1).map((value, i) => value - markerPoint(markers.at(-1))[i])) < 1.2);
  });

  it("builds an elevation-aware AC surface from the measured skidpad", () => {
    const { cones, markers, steps } = measuredSkidpadFixture();
    const route = computeGuidedRoute(cones, markers, steps, { step: 0.5 });
    const track = buildGuidedTrackModel(route, cones, { name: "measured_skidpad" });
    const ai = readFastLane(track.ai);
    const kn5 = readKn5(track.kn5);

    assert.equal(ai.count, route.points.length);
    assert.equal(ai.leftover, 0);
    assert.ok(track.surface.vertices > 100 && track.surface.vertices <= 62000);
    const roadZ = track.mapGeometry.positions.map((position) => position[1]);
    assert.ok(Math.max(...roadZ) - Math.min(...roadZ) > 0.3);
    for (const [side, tag] of [["left", "L"], ["right", "R"], ["center", "C"]]) {
      const alts = cones.filter((cone) => cone.side === side).map((cone) => cone.alt - route.metric.altitudeOffset);
      const bounds = kn5.nodes.find((node) => node.name === `CONE_${tag}`).positionBounds;
      assert.ok(Math.abs(bounds.min[1] - Math.min(...alts)) < 1e-3);
      assert.ok(Math.abs(bounds.max[1] - (Math.max(...alts) + 0.3)) < 1e-3);
    }
  });
});
