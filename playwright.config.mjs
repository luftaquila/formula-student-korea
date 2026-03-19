import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.mjs",
  globalTeardown: "./tests/e2e/global-teardown.mjs",
  timeout: 30000,
  retries: 1,
  workers: 4,
  use: {
    baseURL: "http://localhost:9000",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "auth", testDir: "./tests/e2e/auth", use: { browserName: "chromium" } },
    { name: "entry", testDir: "./tests/e2e/entry", dependencies: ["auth"], use: { browserName: "chromium" } },
    { name: "inspection", testDir: "./tests/e2e/inspection", dependencies: ["entry"], use: { browserName: "chromium" } },
    { name: "queue", testDir: "./tests/e2e/queue", dependencies: ["entry"], use: { browserName: "chromium" } },
    { name: "traffic", testDir: "./tests/e2e/traffic", dependencies: ["entry"], use: { browserName: "chromium" } },
    { name: "score", testDir: "./tests/e2e/score", dependencies: ["inspection", "traffic"], use: { browserName: "chromium" } },
    { name: "documents", testDir: "./tests/e2e/documents", dependencies: ["entry"], use: { browserName: "chromium" } },
    { name: "cross-service", testDir: "./tests/e2e/cross-service", dependencies: ["score"], use: { browserName: "chromium" } },
  ],
  reporter: [["html", { open: "never" }], ["list"], ...(process.env.CI ? [["github"], ["junit", { outputFile: "e2e-results.xml" }]] : [])],
});
