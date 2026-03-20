import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";
import { createJWT } from "../../../shared/express-setup.mjs";

const JWT_SECRET = process.env.JWT_SECRET || "e2e-test-secret";
const TEST_EMAIL = "e2e-role-propagation@test.com";

test.describe("Auth role change propagation", () => {
  test.use({ storageState: storageStatePath("admin") });

  test.afterAll(async () => {
    const headers = { "Content-Type": "application/json", Cookie: getAuthCookie("admin") };
    const usersRes = await fetch(`${BASE_URL}/auth/api/users`, { headers });
    const users = await usersRes.json();
    const testUser = users.find((u) => u.email === TEST_EMAIL);
    if (testUser) {
      await fetch(`${BASE_URL}/auth/api/users/${testUser.id}`, {
        method: "DELETE",
        headers,
      });
    }
  });

  test("DB role change propagates immediately via sliding session sync", async () => {
    const headers = { "Content-Type": "application/json", Cookie: getAuthCookie("admin") };

    // Step 1: Create test user as student
    const createRes = await fetch(`${BASE_URL}/auth/api/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: TEST_EMAIL, role: "student" }),
    });
    expect(createRes.status).toBe(201);

    // Step 2: Create a JWT with student role
    const studentJwt = createJWT({ email: TEST_EMAIL, name: "Role Test User", role: "student" }, JWT_SECRET);

    // Step 3: Verify session initially returns student role
    const sessionRes1 = await fetch(`${BASE_URL}/auth/api/session`, {
      headers: { Cookie: `fsk_session=${studentJwt}` },
    });
    expect(sessionRes1.status).toBe(200);
    const session1 = await sessionRes1.json();
    expect(session1.role).toBe("student");

    // Step 4: Admin changes user's role to official in DB
    const usersRes = await fetch(`${BASE_URL}/auth/api/users`, { headers });
    const users = await usersRes.json();
    const testUser = users.find((u) => u.email === TEST_EMAIL);
    expect(testUser).toBeTruthy();

    const roleRes = await fetch(`${BASE_URL}/auth/api/users/${testUser.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ role: "official" }),
    });
    expect(roleRes.status).toBe(200);

    // Step 5: The middleware's validateUser does a DB lookup and syncs the fresh role
    // Even with the old JWT, the session now returns the updated role
    const sessionRes2 = await fetch(`${BASE_URL}/auth/api/session`, {
      headers: { Cookie: `fsk_session=${studentJwt}` },
    });
    expect(sessionRes2.status).toBe(200);
    const session2 = await sessionRes2.json();
    expect(session2.role).toBe("official");

    // The response also sets a new JWT cookie with the updated role
    const setCookie = sessionRes2.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain("fsk_session=");
  });
});
