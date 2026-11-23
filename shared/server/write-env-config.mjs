#!/usr/bin/env node
// Container entrypoints run this before starting a server so every SPA reads the
// deployment's site configuration from env-config.js. Invalid configuration exits
// non-zero and keeps the container from starting.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderEnvConfig } from "../common/site-config.js";

export function writeEnvConfig(files, env = process.env) {
  const content = renderEnvConfig(env);
  for (const file of files) fs.writeFileSync(file, content);
  return content;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: write-env-config.mjs <env-config.js>...");
    process.exitCode = 2;
  } else {
    try {
      writeEnvConfig(files);
    } catch (error) {
      // Runs before any service logger exists; the container log is the only sink.
      console.error(`Invalid site configuration: ${error.message || error}`);
      process.exitCode = 1;
    }
  }
}
