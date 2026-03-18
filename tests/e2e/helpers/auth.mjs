import fs from "fs";
import path from "path";
import { createJWT } from "../../../shared/express-setup.mjs";

const JWT_SECRET = process.env.JWT_SECRET || "e2e-test-secret";
const BASE_URL = process.env.BASE_URL || "http://localhost:9000";

export const TEST_USERS = {
  admin: { email: "e2e-admin@test.com", name: "E2E Admin", role: "admin" },
  chief: { email: "e2e-chief@test.com", name: "E2E Chief", role: "chief" },
  official: { email: "e2e-official@test.com", name: "E2E Official", role: "official" },
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

export { BASE_URL };
