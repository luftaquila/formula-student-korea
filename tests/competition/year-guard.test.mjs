import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { currentCompetitionYear } from "../../shared/competition-year.mjs";
import { createModuleYearGuard } from "../../competition/lib/year-guard.mjs";

const YEAR = currentCompetitionYear();

function fakeDatabase() {
  return {
    prepare(sql) {
      return {
        get(id) {
          if (sql.includes("sheet_template")) return Number(id) === 12 ? { year: YEAR } : undefined;
          if (sql.includes("session")) return Number(id) === 33 ? { year: YEAR - 1 } : undefined;
          return undefined;
        },
      };
    },
  };
}

describe("Competition mutation year guard", () => {
  it("uses Queue's actual current-year semantics instead of decorative request years", () => {
    const guard = createModuleYearGuard({ module: "queue", db: fakeDatabase() });
    assert.deepEqual(guard({
      query: { year: String(YEAR - 1) }, body: { year: YEAR - 1 }, path: "/api/admin/priority/battery",
    }).years, [YEAR]);
  });

  it("accepts current explicit years and rejects past and future years", () => {
    const guard = createModuleYearGuard({ module: "score", db: fakeDatabase() });
    assert.deepEqual(guard({ query: {}, body: { year: YEAR }, path: "/api/score/manual" }).years, [YEAR]);
    for (const year of [YEAR - 1, YEAR + 1]) {
      assert.throws(
        () => guard({ query: {}, body: { year }, path: "/api/score/manual" }),
        (error) => error.status === 409 && error.code === "YEAR_READ_ONLY" && error.year === year,
      );
    }
  });

  it("uses the stored resource year for ID-addressed mutations", () => {
    const inspection = createModuleYearGuard({ module: "inspection", db: fakeDatabase() });
    assert.deepEqual(inspection({ query: {}, body: {}, path: "/API/SHEET/TEMPLATE/12/" }).years, [YEAR]);
    assert.deepEqual(inspection({ query: {}, body: {}, path: "/api/sheet/template/12/rule-refs" }).years, [YEAR]);
    const documents = createModuleYearGuard({ module: "documents", db: fakeDatabase() });
    assert.throws(
      () => documents({ query: {}, body: {}, path: "/api/sessions/33/submit" }),
      (error) => error.status === 409 && error.code === "YEAR_READ_ONLY" && error.year === YEAR - 1,
    );
  });

  it("rejects malformed explicit years", () => {
    const guard = createModuleYearGuard({ module: "inspection", db: fakeDatabase() });
    assert.throws(
      () => guard({ query: {}, body: { year: 1999 }, path: "/api/sheet/template" }),
      (error) => error.status === 400 && error.code === "INVALID_YEAR",
    );
  });

  it("allows a historical template source while guarding the copy target as a mutation", () => {
    const guard = createModuleYearGuard({ module: "inspection", db: fakeDatabase() });
    assert.deepEqual(guard({
      query: {}, body: { from_year: YEAR - 1, to_year: YEAR }, path: "/api/sheet/template/copy",
    }).years, [YEAR]);
    assert.throws(
      () => guard({
        query: {}, body: { from_year: YEAR - 1, to_year: YEAR + 1 }, path: "/api/sheet/template/copy",
      }),
      (error) => error.status === 409 && error.code === "YEAR_READ_ONLY",
    );
    assert.deepEqual(guard({
      query: {}, body: { from_year: YEAR - 1, to_year: YEAR }, path: "/api/sheet/template/rule-refs/sync",
    }).years, [YEAR]);
    assert.deepEqual(guard({
      query: {}, body: { year: YEAR }, path: "/api/sheet/template/rule-refs/revalidate",
    }).years, [YEAR]);
  });

  it("rejects record mutations when the path name has no parseable competition year", () => {
    const guard = createModuleYearGuard({ module: "traffic", db: fakeDatabase() });
    assert.throws(
      () => guard({ query: {}, body: {}, path: "/api/records/legacy-record/1" }),
      (error) => error.status === 400 && error.code === "INVALID_RECORD_YEAR",
    );
    assert.deepEqual(guard({
      query: {}, body: {}, path: `/api/records/${encodeURIComponent(`FSK ${YEAR} Acceleration`)}/1`,
    }).years, [YEAR]);
  });
});
