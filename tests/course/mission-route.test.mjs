import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ROUTE_OPTIMIZATION_EVALUATIONS,
  duplicateConeIds,
  filterCones,
  groupRouteMapVisits,
  missionConeDisplayName,
  missionConeShortName,
  moveRouteItem,
  optimizeConeRoute,
} from "../../course/web/src/lib/mission-route.mjs";
import { buildSideRanks } from "../../course/lib/cone-index.mjs";

const cones = [
  { id: 1, side: "left", lat: 35.0, lng: 126.0 },
  { id: 2, side: "right", lat: 35.0, lng: 126.003 },
  { id: 3, side: "left", lat: 35.0, lng: 126.001 },
];

test("filters hundreds-friendly cone fields by side and query", () => {
  assert.deepEqual(filterCones(cones, { side: "left" }).map((cone) => cone.id), [1, 3]);
  assert.deepEqual(filterCones(cones, { query: "2" }).map((cone) => cone.id), [2]);
});

test("gives map and lists the same stable side-relative cone names", () => {
  const unsorted = [cones[2], cones[1], cones[0]];
  const ranks = buildSideRanks(unsorted);
  assert.equal(missionConeDisplayName(cones[0], ranks), "왼쪽 #1");
  assert.equal(missionConeDisplayName(cones[2], ranks), "왼쪽 #2");
  assert.equal(missionConeDisplayName(cones[1], ranks), "오른쪽 #1");
  assert.equal(missionConeShortName(cones[2], ranks), "L-2");
  assert.equal(missionConeDisplayName(null, ranks), "알 수 없는 콘");
});

test("groups repeated map visits without hiding a moved cone snapshot", () => {
  const visits = [
    { cone_id: 1, lat: 35, lng: 126 },
    { cone_id: 2, lat: 35.1, lng: 126.1 },
    { cone_id: 1, lat: 35, lng: 126 },
    { cone_id: 1, lat: 35.2, lng: 126.2 },
    { cone_id: 3, lat: null, lng: 126 },
  ];
  assert.deepEqual(groupRouteMapVisits(visits).map((group) => group.map(({ index }) => index)), [
    [0, 2], [1], [3],
  ]);
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
