import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import uiModules from "../../competition/ui-modules.json" with { type: "json" };

const build = parse(fs.readFileSync(".github/workflows/build.yml", "utf8"));
const test = parse(fs.readFileSync(".github/workflows/test.yml", "utf8"));
const workspace = parse(fs.readFileSync("pnpm-workspace.yaml", "utf8"));

function imagePlan(workflow, changedPaths, stepName) {
  const steps = workflow.jobs.changes.steps;
  const filters = parse(steps.find((step) => step.id === "filter").with.filters);
  const matched = Object.fromEntries(Object.entries(filters).map(([name, patterns]) => [
    name,
    patterns.some((pattern) => changedPaths.some((file) => pattern.endsWith("/**")
      ? file.startsWith(pattern.slice(0, -2)) : file === pattern)),
  ]));
  const step = steps.find((step) => step.name === stepName);
  const env = { ...process.env };
  for (const [key, value] of Object.entries(step.env)) {
    const filter = /steps\.filter\.outputs\.([\w-]+)/.exec(value)?.[1];
    env[key] = filter ? String(matched[filter]) : "false";
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-image-plan-"));
  env.GITHUB_OUTPUT = path.join(dir, "outputs");
  try {
    const result = spawnSync("bash", ["-c", step.run], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(fs.readFileSync(env.GITHUB_OUTPUT, "utf8").trim().split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function copiedInputs() {
  return fs.readFileSync("competition/Dockerfile", "utf8").split("\n")
    .filter((line) => /^COPY\s/.test(line))
    .map((line) => {
      const tokens = line.trim().split(/\s+/).slice(1);
      const options = tokens.filter((token) => token.startsWith("--"));
      const paths = tokens.filter((token) => !token.startsWith("--"));
      return { stage: options.find((token) => token.startsWith("--from="))?.slice(7),
        sources: paths.slice(0, -1), destination: paths.at(-1).replace(/\/$/, "") };
    });
}

describe("Competition deployment contract", () => {
  it("keeps the seven public UI names and resolves their nested source and image directories", () => {
    assert.deepEqual(Object.keys(uiModules), ["entry", "queue", "registration", "inspection", "traffic", "score", "documents"]);
    assert.equal(uiModules.entry, "teams");
    const copies = copiedInputs();
    for (const [name, directory] of Object.entries(uiModules)) {
      const root = `competition/modules/${directory}`;
      assert.ok(fs.existsSync(`${root}/index.mjs`));
      assert.ok(fs.existsSync(`${root}/web/package.json`));
      assert.ok(workspace.packages.includes(`${root}/web`));
      assert.ok(!fs.existsSync(`${root}/package.json`), "backend dependencies belong to Competition");
      assert.ok(copies.some((copy) => !copy.stage && copy.sources.includes(`${root}/web/package.json`)));
      assert.ok(copies.some((copy) => copy.sources.includes(`${root}/server`) && copy.destination === `${root}/server`));
      assert.ok(copies.some((copy) => copy.stage === `${name}-web`
        && copy.sources.includes(`/workspace/${root}/web/dist`) && copy.destination === `${root}/web/dist`));
    }
    assert.ok(copies.some((copy) => copy.sources.includes("competition/ui-modules.json")));
  });

  it("builds the Competition image for every module's backend and SPA", () => {
    for (const directory of Object.values(uiModules)) {
      for (const suffix of ["server/store.mjs", "web/src/App.vue"]) {
        const changed = [`competition/modules/${directory}/${suffix}`];
        const published = imagePlan(build, changed, "Build matrix");
        assert.deepEqual(JSON.parse(published["services-matrix"]).include.map((item) => item.service), ["competition"]);
        const e2e = imagePlan(test, changed, "Plan builds vs pulls");
        assert.equal(e2e.bake_targets, "competition");
        assert.ok(!e2e.pull_std.split(" ").includes("competition"));
      }
    }
  });

  it("rebuilds every application for all shared-code areas and workspace inputs", () => {
    for (const file of ["shared/browser/NavMenu.vue", "shared/server/logger.mjs", "shared/common/access-control.js", "shared/build/vite-config.js", "pnpm-workspace.yaml"]) {
      const published = imagePlan(build, [file], "Build matrix");
      assert.deepEqual(JSON.parse(published["services-matrix"]).include.map((item) => item.service), ["auth", "competition", "email", "course", "calendar", "caddy"]);
      assert.equal(imagePlan(test, [file], "Plan builds vs pulls").bake_targets, "auth,competition,email,course,calendar,caddy-local");
    }
  });
});
