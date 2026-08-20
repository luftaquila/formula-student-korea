import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  competitionDateStart,
  competitionYearBounds,
  currentCompetitionYear,
  formatCompetitionDate,
} from "../../shared/competition-year.mjs";

const testWorkflow = fs.readFileSync(".github/workflows/test.yml", "utf8");
const buildWorkflow = fs.readFileSync(".github/workflows/build.yml", "utf8");

function dockerContextFilter(workflow) {
  return workflow.match(/            docker-context:\n((?:              - .+\n)+)/)?.[1] || "";
}

function e2eShards(workflow) {
  const matrix = workflow.match(/        include:\n([\s\S]+?)\n    steps:/)?.[1] || "";
  return [...matrix.matchAll(/          - shard: ([^\n]+)\n([\s\S]*?)(?=          - shard:|$)/g)]
    .map(([, shard, body]) => ({ shard, body }));
}

describe("CI workflow operational contracts", () => {
  it("runs unit tests in Seoul time and preserves the UTC/KST year boundary", () => {
    assert.match(testWorkflow, /  unit:\n    runs-on: ubuntu-latest\n    env:\n      TZ: Asia\/Seoul\n/);
    assert.equal(currentCompetitionYear(new Date("2025-12-31T14:59:59.999Z")), 2025);
    assert.equal(currentCompetitionYear(new Date("2025-12-31T15:00:00.000Z")), 2026);
    assert.equal(competitionDateStart("2026-01-01"), Date.parse("2025-12-31T15:00:00.000Z"));
    assert.equal(formatCompetitionDate(Date.parse("2026-01-01T00:30:00.000Z")), "2026-01-01");
    assert.deepEqual(competitionYearBounds(2026), {
      from: Date.parse("2025-12-31T15:00:00.000Z"),
      toExclusive: Date.parse("2026-12-31T15:00:00.000Z"),
      to: Date.parse("2026-12-31T14:59:59.999Z"),
    });
    assert.deepEqual(competitionYearBounds(2099), {
      from: Date.parse("2098-12-31T15:00:00.000Z"),
      toExclusive: Date.parse("2099-12-31T15:00:00.000Z"),
      to: Date.parse("2099-12-31T14:59:59.999Z"),
    });
    assert.equal(competitionDateStart("2026-02-30"), null);
  });

  it("rebuilds every standard and Caddy image when .dockerignore changes", () => {
    for (const workflow of [testWorkflow, buildWorkflow]) {
      assert.match(dockerContextFilter(workflow), /- '\.dockerignore'/);
      assert.ok((workflow.match(/\$DOCKER_CONTEXT/g) || []).length >= 2);
    }
  });

  it("treats Registration as Competition code in build, unit, and E2E plans", () => {
    for (const workflow of [testWorkflow, buildWorkflow]) {
      assert.match(workflow, /            registration:\n              - 'registration\/\*\*'/);
      assert.match(workflow, /F_REGISTRATION: \$\{\{ steps\.filter\.outputs\.registration \}\}/);
      assert.match(workflow, /"\$F_QUEUE" "\$F_REGISTRATION" "\$F_INSPECTION"/);
    }
    assert.match(testWorkflow, /registration\/package-lock\.json/);
    assert.match(testWorkflow, /for dir in auth queue registration inspection/);
    assert.match(testWorkflow, /- shard: registration\n            projects: --project=registration/);
  });

  it("starts Email in every E2E shard that seeds users", () => {
    const userShards = e2eShards(testWorkflow)
      .filter(({ body }) => /^            seeds: .*\busers\b/m.test(body));

    assert.ok(userShards.length > 0);
    for (const { shard, body } of userShards) {
      assert.match(
        body,
        /^            services: .*\bemail\b/m,
        `${shard} seeds Auth users, whose creation sends an Email notification`,
      );
    }
  });
});
