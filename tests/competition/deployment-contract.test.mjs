import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function competitionModules() {
  const source = fs.readFileSync("competition/index.mjs", "utf8");
  const match = source.match(/const UI_MODULES = Object\.freeze\((\[[^\n]+\])\);/);
  assert.ok(match, "Competition UI module declaration must remain machine-readable");
  return JSON.parse(match[1]);
}

describe("Competition deployment contract", () => {
  it("maps every composed module into CI and the Competition image", () => {
    const modules = competitionModules();
    const workflow = fs.readFileSync(".github/workflows/build.yml", "utf8");
    const dockerfile = fs.readFileSync("competition/Dockerfile", "utf8");
    const webStages = [...dockerfile.matchAll(/^FROM web-base AS ([a-z]+)-web$/gm)]
      .map((match) => match[1]);

    assert.deepEqual(modules, [
      "entry", "queue", "registration", "inspection", "traffic", "score", "documents",
    ]);
    for (const module of modules) {
      const filter = [
        `            ${module}:`,
        `              - '${module}/**'`,
      ].join("\n");
      assert.ok(workflow.includes(filter), `Build Images path filter is missing ${module}`);
      assert.ok(workflow.includes(`F_${module.toUpperCase()}`),
        `Build Images competition mapping is missing ${module}`);
      assert.ok(webStages.includes(module),
        `Competition Dockerfile independent build stage is missing ${module}`);
      assert.ok(dockerfile.includes(`COPY ${module}/web/package.json ${module}/web/package.json`),
        `Competition image dependency copy is missing ${module}`);
      assert.ok(dockerfile.includes(`COPY --from=${module}-web /workspace/${module}/web/dist ${module}/web/dist/`),
        `Competition runtime image is missing ${module}`);
    }
  });
});
