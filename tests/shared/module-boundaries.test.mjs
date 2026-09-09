import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import { babelParse, parse as parseSfc } from "vue/compiler-sfc";

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file)
      : /\.(?:m?js|vue)$/.test(file) ? [file] : [];
  });
}

function imports(file) {
  const text = fs.readFileSync(file, "utf8");
  const descriptor = file.endsWith(".vue") ? parseSfc(text, { filename: file }).descriptor : null;
  const scripts = descriptor ? [descriptor.script, descriptor.scriptSetup].filter(Boolean).map(script => script.content) : [text];
  return scripts.flatMap((source) => {
    const ast = babelParse(source, { sourceType: "module" });
    const dependencies = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) {
        dependencies.push(node.source.value);
      }
      if (node.type === "CallExpression" && node.callee.type === "Import" && node.arguments[0]?.type === "StringLiteral") dependencies.push(node.arguments[0].value);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    }
    visit(ast.program);
    return dependencies;
  });
}

it("shared code respects its browser, server, common, and build boundaries", () => {
  const allowed = {
    browser: new Set(["browser", "common"]),
    server: new Set(["server", "common"]),
    common: new Set(["common"]),
    build: new Set(["build", "common"]),
  };
  for (const [area, targets] of Object.entries(allowed)) {
    for (const file of sourceFiles(`shared/${area}`)) {
      for (const dependency of imports(file)) {
        if (dependency.startsWith(".")) {
          const target = path.normalize(path.join(path.dirname(file), dependency));
          assert.ok(target.startsWith("shared/"), `${file} must not depend on an application: ${dependency}`);
          assert.ok(targets.has(target.split(path.sep)[1]), `${file} crosses its execution boundary: ${dependency}`);
        } else if (area === "common" || area === "browser") {
          assert.ok(!isBuiltin(dependency), `${file} imports a Node-only dependency: ${dependency}`);
          if (area === "common") assert.fail(`${file} must stay independent of external runtimes: ${dependency}`);
        }
      }
    }
  }
});
