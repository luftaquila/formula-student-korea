import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ROUTE_OPTIMIZATION_EVALUATIONS,
  duplicateConeIds,
  filterCones,
  moveRouteItem,
  optimizeConeRoute,
} from "../../course/web/src/lib/mission-route.mjs";

const cones = [
  { id: 1, side: "left", lat: 35.0, lng: 126.0 },
  { id: 2, side: "right", lat: 35.0, lng: 126.003 },
  { id: 3, side: "left", lat: 35.0, lng: 126.001 },
];

test("filters hundreds-friendly cone fields by side and query", () => {
  assert.deepEqual(filterCones(cones, { side: "left" }).map((cone) => cone.id), [1, 3]);
  assert.deepEqual(filterCones(cones, { query: "2" }).map((cone) => cone.id), [2]);
});

test("optimizes from the live start while preserving occurrence identity", () => {
  const repeated = [{ ...cones[1], cone_id: 2, key: "a" }, { ...cones[0], cone_id: 1, key: "b" }, { ...cones[1], cone_id: 2, key: "c" }];
  const result = optimizeConeRoute(repeated, { lat: 35.0, lng: 126.0 });
  assert.equal(result[0].cone_id, 1);
  assert.deepEqual(new Set(result.map((item) => item.key)), new Set(["a", "b", "c"]));
  assert.deepEqual(duplicateConeIds(result), [2]);
});

test("keeps large-route optimization inside a deterministic evaluation budget", () => {
  const many = Array.from({ length: 2000 }, (_, index) => ({
    cone_id: index + 1,
    lat: 35 + (index % 100) * 0.00001,
    lng: 126 + Math.floor(index / 100) * 0.00001,
  }));
  let evaluations = 0;
  const maxEvaluations = 5000;
  const result = optimizeConeRoute(many, { lat: 35, lng: 126 }, 12, {
    maxEvaluations,
    onEvaluation: (count) => { evaluations = count; },
  });
  assert.equal(result.length, many.length);
  assert.deepEqual(new Set(result.map((item) => item.cone_id)), new Set(many.map((item) => item.cone_id)));
  assert.ok(evaluations <= maxEvaluations);
  let defaultEvaluations = 0;
  optimizeConeRoute(many, { lat: 35, lng: 126 }, 12, {
    onEvaluation: (count) => { defaultEvaluations = count; },
  });
  assert.ok(defaultEvaluations <= DEFAULT_ROUTE_OPTIMIZATION_EVALUATIONS);
});

test("moves an arbitrary occurrence directly to a requested position", () => {
  assert.deepEqual(moveRouteItem(["a", "b", "c", "d"], 3, 1), ["a", "d", "b", "c"]);
});
