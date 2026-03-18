import { writeStorageStates, BASE_URL } from "./helpers/auth.mjs";
import { seedAll } from "./helpers/seed.mjs";

async function waitForServices(maxRetries = 30, intervalMs = 2000) {
  const services = [
    "/auth/api/health",
    "/entry/api/health",
    "/queue/api/health",
    "/inspection/api/health",
    "/traffic/api/health",
    "/score/api/health",
    "/documents/api/health",
  ];

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

export default async function globalSetup() {
  console.log("[setup] Waiting for services...");
  await waitForServices();

  console.log("[setup] Writing storage states...");
  writeStorageStates();

  console.log("[setup] Seeding test data...");
  await seedAll();

  console.log("[setup] Global setup complete.");
}
