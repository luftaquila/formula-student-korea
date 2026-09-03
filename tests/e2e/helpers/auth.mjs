import fs from "fs";
import path from "path";
import { createJWT } from "../../../shared/express-setup.mjs";

const JWT_SECRET = process.env.JWT_SECRET || "e2e-test-secret";
const BASE_URL = process.env.BASE_URL || "http://localhost:9000";
// Mirrors the CI/compose value (.github/workflows/test.yml "Create .env"). Used
// by security tests to forge the inter-service header and prove Caddy strips it,
// and by tests that legitimately drive rover-side endpoints through Caddy.
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "e2e-internal-secret";

export const TEST_USERS = {
  admin: { email: "e2e-admin@test.com", name: "E2E Admin", role: "admin" },
  chief: { email: "e2e-chief@test.com", name: "E2E Chief", role: "chief" },
  official: { email: "e2e-official@test.com", name: "E2E Official", role: "official" },
  staff: { email: "e2e-staff@test.com", name: "E2E Staff", role: "staff" },
  student: { email: "e2e-student@test.com", name: "E2E Student", role: "student" },
};

export function getAdminJwt() {
  return createJWT(TEST_USERS.admin, JWT_SECRET);
}

export function createStorageState(role) {
  const user = TEST_USERS[role];
  const jwt = createJWT(user, JWT_SECRET);
  const fskUser = encodeURIComponent(JSON.stringify({ name: user.name, role: user.role }));
  return {
    cookies: [
      { name: "fsk_session", value: jwt, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
      { name: "fsk_user", value: fskUser, domain: "localhost", path: "/", sameSite: "Lax" },
    ],
    origins: [],
  };
}

export function writeStorageStates() {
  const authDir = path.resolve("tests/e2e/.auth");
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  for (const role of Object.keys(TEST_USERS)) {
    const state = createStorageState(role);
    fs.writeFileSync(path.join(authDir, `${role}.json`), JSON.stringify(state, null, 2));
  }
}

export function getAuthCookie(role = "admin") {
  const user = TEST_USERS[role];
  return `fsk_session=${createJWT(user, JWT_SECRET)}`;
}

// Header an internal service would send. Through Caddy this is stripped on every
// path EXCEPT /course/api/rover/* (rover lives on the open internet), so it
// doubles as the "forged header" for stripping tests and the real header for
// rover-edge tests.
export function internalHeaders() {
  return { "X-Internal-Service": INTERNAL_SECRET };
}

export { BASE_URL, INTERNAL_SECRET };
