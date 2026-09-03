import fs from "fs";
import path from "path";
import { createJWT } from "../../../shared/express-setup.mjs";
import { expandPermissions, PERMISSION_KEYS } from "../../../shared/access-control.js";

const JWT_SECRET = process.env.JWT_SECRET || "e2e-test-secret";
const BASE_URL = process.env.BASE_URL || "http://localhost:9000";
// Mirrors the CI/compose value (.github/workflows/test.yml "Create .env"). Used
// by security tests to forge the inter-service header and prove Caddy strips it,
// and by tests that legitimately drive rover-side endpoints through Caddy.
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "e2e-internal-secret";

function account({ bundles = [], directPermissions = [], ...user }) {
  const permissions = user.role === "admin"
    ? [...PERMISSION_KEYS]
    : expandPermissions({ bundles, directPermissions });
  return Object.freeze({
    ...user,
    bundles: Object.freeze(bundles),
    directPermissions: Object.freeze(directPermissions),
    permissions: Object.freeze(permissions),
    accessRevision: user.role === "official" && (bundles.length > 0 || directPermissions.length > 0) ? 1 : 0,
  });
}

// The keys name capability profiles, not application roles. Every operational
// profile is an official account with explicit permission bundles.
export const TEST_USERS = Object.freeze({
  admin: account({ email: "e2e-admin@test.com", name: "E2E Admin", role: "admin" }),
  technicalOperator: account({
    email: "e2e-technical-operator@test.com",
    name: "E2E Technical Operator",
    role: "official",
    bundles: ["course_editor", "timing_operator", "score_operator"],
  }),
  operationsManager: account({
    email: "e2e-operations-manager@test.com",
    name: "E2E Operations Manager",
    role: "official",
    bundles: [
      "registration_manager",
      "queue_manager",
      "inspection_manager",
      "documents_manager",
      "calendar_manager",
    ],
  }),
  operationsOperator: account({
    email: "e2e-operations-operator@test.com",
    name: "E2E Multi-service Operator",
    role: "official",
    bundles: ["registration_operator", "queue_operator", "inspection_operator"],
  }),
  registrationOperator: account({
    email: "e2e-registration-operator@test.com",
    name: "E2E Registration Operator",
    role: "official",
    bundles: ["registration_operator"],
  }),
  student: account({ email: "e2e-student@test.com", name: "E2E Student", role: "student" }),
});

export function getAdminJwt() {
  return createJWT(TEST_USERS.admin, JWT_SECRET);
}

export function createStorageState(profile) {
  const user = TEST_USERS[profile];
  const jwt = createJWT({
    email: user.email,
    name: user.name,
    role: user.role,
    accessRevision: user.accessRevision,
  }, JWT_SECRET);
  const fskUser = encodeURIComponent(JSON.stringify({
    name: user.name,
    role: user.role,
    permissions: user.permissions,
    accessRevision: user.accessRevision,
  }));
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

  for (const profile of Object.keys(TEST_USERS)) {
    const state = createStorageState(profile);
    fs.writeFileSync(path.join(authDir, `${profile}.json`), JSON.stringify(state, null, 2));
  }
}

export function getAuthCookie(profile = "admin") {
  const user = TEST_USERS[profile];
  return `fsk_session=${createJWT({
    email: user.email,
    name: user.name,
    role: user.role,
    accessRevision: user.accessRevision,
  }, JWT_SECRET)}`;
}

// Header an internal service would send. Through Caddy this is stripped on every
// path EXCEPT /course/api/rover/* (rover lives on the open internet), so it
// doubles as the "forged header" for stripping tests and the real header for
// rover-edge tests.
export function internalHeaders() {
  return { "X-Internal-Service": INTERNAL_SECRET };
}

export { BASE_URL, INTERNAL_SECRET };
