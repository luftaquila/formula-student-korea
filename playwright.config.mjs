import { defineConfig } from "@playwright/test";

// E2E fixtures that construct calendar dates use the same competition timezone
// as the server, independent of the CI runner's host timezone.
process.env.TZ = "Asia/Seoul";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.mjs",
  globalTeardown: "./tests/e2e/global-teardown.mjs",
  timeout: 30000,
  retries: 1,
  failOnFlakyTests: Boolean(process.env.CI),
  workers: 2,
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
    { name: "registration", testDir: "./tests/e2e/registration", dependencies: ["entry"], use: { browserName: "chromium" } },
    { name: "traffic", testDir: "./tests/e2e/traffic", dependencies: ["entry"], use: { browserName: "chromium" } },
    { name: "score", testDir: "./tests/e2e/score", dependencies: ["inspection", "traffic"], use: { browserName: "chromium" } },
    { name: "documents", testDir: "./tests/e2e/documents", dependencies: ["entry"], use: { browserName: "chromium" } },
    { name: "course", testDir: "./tests/e2e/course", use: { browserName: "chromium" } },
    { name: "calendar", testDir: "./tests/e2e/calendar", use: { browserName: "chromium" } },
    { name: "security", testDir: "./tests/e2e/security", use: { browserName: "chromium" } },
    { name: "cross-service", testDir: "./tests/e2e/cross-service", dependencies: ["score"], use: { browserName: "chromium" } },
  ],
  reporter: [["html", { open: "never" }], ["list"], ...(process.env.CI ? [["github"], ["junit", { outputFile: "e2e-results.xml" }]] : [])],
});
