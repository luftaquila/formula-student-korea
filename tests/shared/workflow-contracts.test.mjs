import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse } from "yaml";

import {
  competitionDateStart,
  competitionYearBounds,
  currentCompetitionYear,
  formatCompetitionDate,
} from "../../shared/competition-year.mjs";

const testWorkflow = fs.readFileSync(".github/workflows/test.yml", "utf8");
const buildWorkflow = fs.readFileSync(".github/workflows/build.yml", "utf8");
const testWorkflowConfig = parse(testWorkflow);
const pnpmSetupAction = fs.readFileSync(".github/actions/setup-pnpm/action.yml", "utf8");
const roverWorkflow = parse(fs.readFileSync(".github/workflows/rover.yml", "utf8"));
const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const workspaceConfig = fs.readFileSync("pnpm-workspace.yaml", "utf8");
const workspaceLock = fs.readFileSync("pnpm-lock.yaml", "utf8");

function dockerContextFilter(workflow) {
  return workflow.match(/            docker-context:\n((?:              - .+\n)+)/)?.[1] || "";
}

function e2eShards(workflow) {
  const matrix = workflow.match(/        include:\n([\s\S]+?)\n    steps:/)?.[1] || "";
  return [...matrix.matchAll(/          - shard: ([^\n]+)\n([\s\S]*?)(?=          - shard:|$)/g)]
    .map(([, shard, body]) => ({ shard, body }));
}

function projectSpecs(body, project) {
  const pattern = new RegExp(`tests/e2e/${project}/[^\\s]+\\.spec\\.mjs`, "g");
  return [...body.matchAll(pattern)].map(([spec]) => spec);
}

function assertShardCoverage(project) {
  const actual = fs.readdirSync(`tests/e2e/${project}`)
    .filter((name) => name.endsWith(".spec.mjs"))
    .map((name) => `tests/e2e/${project}/${name}`)
    .sort();
  const listed = e2eShards(testWorkflow)
    .filter(({ shard }) => shard.startsWith(`${project}-`))
    .flatMap(({ body }) => projectSpecs(body, project));

  assert.equal(
    new Set(listed).size,
    listed.length,
    `${project} specs must not be listed more than once`,
  );
  assert.deepEqual(listed.toSorted(), actual);
}

describe("CI workflow operational contracts", () => {
  it("routes all Rover automation through one component-aware workflow", () => {
    const roverWorkflowFiles = fs.readdirSync(".github/workflows")
      .filter((name) => name.startsWith("rover-") || name === "rover.yml");
    const components = ["pilot", "perception", "host", "mcu", "gps"];
    const dispatchComponents = [...components, "sd"];
    const pushPaths = [
      "rover/gps/**",
      "rover/host/**",
      "rover/mcu/**",
      "rover/perception/**",
      "rover/pilot/**",
      ".github/workflows/rover.yml",
    ];
    const filterStep = roverWorkflow.jobs.changes.steps
      .find((step) => step.uses === "dorny/paths-filter@v4");
    const filters = parse(filterStep.with.filters);

    assert.deepEqual(roverWorkflowFiles, ["rover.yml"]);
    assert.deepEqual(roverWorkflow.on.push.branches, ["main"]);
    assert.deepEqual(roverWorkflow.on.push.paths, pushPaths);
    assert.deepEqual(
      roverWorkflow.on.workflow_dispatch.inputs.component.options,
      dispatchComponents,
    );

    for (const component of components) {
      const expectedCondition =
        `(github.event_name == 'workflow_dispatch' && inputs.component == '${component}') || `
        + `needs.changes.outputs.${component} == 'true'`;
      const jobNames = component === "pilot" || component === "perception"
        ? [`${component}-verify`, component]
        : [component];

      assert.equal(
        roverWorkflow.jobs.changes.outputs[component],
        `\${{ steps.filter.outputs.${component} }}`,
      );
      assert.deepEqual(
        filters[component],
        component === "gps"
          ? [
              "rover/gps/**",
              "rover/pilot/pilot/lib/**",
              ".github/workflows/rover.yml",
            ]
          : [`rover/${component}/**`, ".github/workflows/rover.yml"],
      );
      for (const jobName of jobNames) {
        const job = roverWorkflow.jobs[jobName];
        const expectedNeeds = jobName === component && jobNames.length === 2
          ? ["changes", `${component}-verify`]
          : "changes";

        assert.equal(job.if, expectedCondition);
        assert.deepEqual(job.needs, expectedNeeds);
      }
    }

    assert.equal(filterStep.if, "github.event_name == 'push'");
    assert.equal(filters.sd, undefined);
    assert.equal(
      roverWorkflow.jobs.sd.if,
      "github.event_name == 'workflow_dispatch' && inputs.component == 'sd'",
    );
    assert.deepEqual(roverWorkflow.jobs.sd.needs, "changes");

    for (const component of ["pilot", "perception"]) {
      const verify = roverWorkflow.jobs[`${component}-verify`];
      const publish = roverWorkflow.jobs[component];

      assert.equal(verify.concurrency.group, publish.concurrency.group);
      assert.equal(verify.concurrency["cancel-in-progress"], true);
      assert.equal(publish.concurrency["cancel-in-progress"], true);
    }
  });

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

  it("rebuilds every standard and Caddy image when Docker inputs change", () => {
    for (const workflow of [testWorkflow, buildWorkflow]) {
      const filter = dockerContextFilter(workflow);
      for (const path of [".dockerignore", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
        assert.match(filter, new RegExp(`- '${path.replaceAll(".", "\\.")}'`));
      }
      assert.ok((workflow.match(/\$DOCKER_CONTEXT/g) || []).length >= 2);
    }
  });

  it("caches the pinned pnpm executable and retries cache misses", () => {
    assert.equal(packageManifest.packageManager, "pnpm@11.25.0");
    assert.equal((testWorkflow.match(/uses: \.\/\.github\/actions\/setup-pnpm/g) || []).length, 2);
    assert.doesNotMatch(testWorkflow, /uses: pnpm\/setup|download-artifact|  toolchain:/);
    assert.equal((pnpmSetupAction.match(/uses: pnpm\/setup@v2\.1\.0/g) || []).length, 2);
    assert.match(pnpmSetupAction, /key: pnpm-home-v2\.1\.0-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ steps\.pnpm-version\.outputs\.version \}\}/);
    assert.match(pnpmSetupAction, /steps\.pnpm-setup\.outcome == 'failure'[\s\S]+?uses: pnpm\/setup@v2\.1\.0/);
    assert.doesNotMatch(pnpmSetupAction, /restore-keys:|cache: true/);
    assert.match(testWorkflow, /  unit:\n    runs-on: ubuntu-latest\n/);
    assert.match(testWorkflow, /run: pnpm install --frozen-lockfile/);
    assert.doesNotMatch(testWorkflow, /package-lock\.json|\bnpm ci\b/);
  });

  it("keys the browser cache by the installed Playwright version", () => {
    const installAt = testWorkflow.lastIndexOf("      - name: Install dependencies\n");
    const versionAt = testWorkflow.indexOf("      - name: Resolve Playwright version\n");
    const restoreAt = testWorkflow.indexOf("      - name: Restore Playwright cache\n");

    assert.ok(installAt >= 0 && installAt < versionAt && versionAt < restoreAt);
    assert.match(testWorkflow, /id: playwright-version[\s\S]+?require\('@playwright\/test\/package\.json'\)\.version/);
    assert.equal(
      (testWorkflow.match(/key: playwright-\$\{\{ runner\.os \}\}-chromium-\$\{\{ steps\.playwright-version\.outputs\.version \}\}/g) || []).length,
      2,
    );
    assert.doesNotMatch(testWorkflow, /key: playwright-[^\n]+hashFiles\('pnpm-lock\.yaml'\)/);
    assert.match(testWorkflow, /run: pnpm exec playwright install chromium/);
    assert.doesNotMatch(testWorkflow, /playwright install --with-deps/);
    assert.match(
      testWorkflow,
      /if: always\(\) && steps\.playwright-install\.outcome == 'success' && steps\.playwright-cache\.outputs\.cache-hit != 'true'/,
    );
  });

  it("imports service-scoped main caches without exporting shard caches", () => {
    const e2eSteps = testWorkflowConfig.jobs.e2e.steps;
    const cachedBuild = e2eSteps.find((step) => step.name === "Build changed images");
    const fallbackBuild = e2eSteps.find((step) =>
      step.name === "Build changed images (retry without cache import)"
    );
    const scopes = [...cachedBuild.with.set.matchAll(/\.cache-from=type=gha,scope=([a-z-]+)-amd64/g)]
      .map((match) => match[1])
      .sort();

    assert.deepEqual(scopes, ["auth", "caddy", "calendar", "competition", "course", "email"]);
    assert.doesNotMatch(cachedBuild.with.set, /cache-to=/);
    assert.equal(cachedBuild["continue-on-error"], true);
    assert.equal(fallbackBuild.if, "steps.cached-build.outcome == 'failure'");
    assert.equal(fallbackBuild.with.set, undefined);
  });

  it("treats Registration as Competition code in build, unit, and E2E plans", () => {
    for (const workflow of [testWorkflow, buildWorkflow]) {
      assert.match(workflow, /            registration:\n              - 'registration\/\*\*'/);
      assert.match(workflow, /F_REGISTRATION: \$\{\{ steps\.filter\.outputs\.registration \}\}/);
      assert.match(workflow, /"\$F_QUEUE" "\$F_REGISTRATION" "\$F_INSPECTION"/);
    }
    assert.match(workspaceConfig, /^  - registration$/m);
    assert.match(workspaceLock, /^  registration:$/m);
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

  it("lists every explicitly sharded E2E spec exactly once", () => {
    for (const project of ["auth", "inspection", "queue", "score", "traffic"]) {
      assertShardCoverage(project);
    }
  });
});
