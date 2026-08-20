import { writeStorageStates, getAuthCookie, BASE_URL } from "./helpers/auth.mjs";
import { seedSelected } from "./helpers/seed.mjs";

const ALL_SERVICES = [
  "auth",
  "competition",
  "email",
  "course",
  "calendar",
];
const ALL_SEEDS = ["users", "vehicle-types", "entries", "inspection", "documents"];

function selectedNames(envName, defaults) {
  const value = process.env[envName]?.trim();
  return value ? value.split(/\s+/) : defaults;
}

async function waitForServices(maxRetries = 30, intervalMs = 2000) {
  const services = selectedNames("E2E_SERVICES", ALL_SERVICES).map((service) => (
    service === "competition"
      ? "/competition/api/v1/queue/health"
      : `/${service}/api/health`
  ));

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const results = await Promise.all(
        services.map((path) =>
          fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(3000) })
            .then((r) => r.ok)
            .catch(() => false)
        )
      );
      if (results.every(Boolean)) {
        console.log(`[setup] All services healthy (attempt ${attempt})`);
        return;
      }
      const unhealthy = services.filter((_, i) => !results[i]);
      console.log(`[setup] Waiting for: ${unhealthy.join(", ")} (attempt ${attempt}/${maxRetries})`);
    } catch {
      console.log(`[setup] Health check failed (attempt ${attempt}/${maxRetries})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Services did not become healthy in time");
}

export async function waitForCompetitionAuthentication({
  maxRetries = 10,
  intervalMs = 500,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
} = {}) {
  const path = "/competition/api/v1/logs?limit=1";
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ready = await fetchImpl(`${BASE_URL}${path}`, {
      headers: { Cookie: getAuthCookie("admin") },
      signal: AbortSignal.timeout(3000),
    }).then((response) => response.ok).catch(() => false);

    if (ready) {
      log(`[setup] Competition authentication ready (attempt ${attempt})`);
      return;
    }
    log(`[setup] Waiting for Competition authentication (attempt ${attempt}/${maxRetries})`);
    if (attempt < maxRetries) await sleep(intervalMs);
  }
  throw new Error("Competition authentication did not become ready in time");
}

export default async function globalSetup() {
  const services = selectedNames("E2E_SERVICES", ALL_SERVICES);
  const seeds = selectedNames("E2E_SEEDS", ALL_SEEDS);

  console.log("[setup] Waiting for services...");
  await waitForServices();

  console.log("[setup] Writing storage states...");
  writeStorageStates();

  console.log("[setup] Seeding test data...");
  await seedSelected(seeds, {
    // Public health proves that Caddy and Competition can answer, but not that
    // Competition's fail-close Auth revalidation path is usable. User seeding
    // also starts asynchronous notification requests, so verify the protected
    // path after that work rather than racing the first Competition mutation.
    afterEach: async (name) => {
      if (name === "users" && services.includes("competition")) {
        console.log("[setup] Verifying Competition authentication...");
        await waitForCompetitionAuthentication();
      }
    },
  });

  console.log("[setup] Global setup complete.");
}
