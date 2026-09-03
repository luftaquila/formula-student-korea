import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";
import { createJWT } from "../../../shared/express-setup.mjs";

// Cross-service fail-close propagation:
// Every non-auth service resolves an authoritative access snapshot from Auth.
// Once Auth deactivates a user, the lookup returns 404 and the downstream
// middleware nulls req.user, so a following request is rejected.
//
// The existing tests/e2e/auth/role-propagation.spec.mjs only covers the in-auth
// sliding-session ROLE sync (student → official) hitting /auth/api/session. This
// spec covers the orthogonal DEACTIVATION → downstream-denial path against a
// different service (documents), which that spec does not exercise.
//
// We use the documents service: GET /competition/api/v1/documents/sessions is
// exact-student self-service. It returns 200 even with no student-team mapping, so the result
// hinges purely on the active flag — exactly what we're proving.

const JWT_SECRET = process.env.JWT_SECRET || "e2e-test-secret";
// Unique email per run so parallel shards / retries never collide on the
// users table (email UNIQUE) and so deactivation only affects this user.
const TEST_EMAIL = `e2e-deact-${Date.now()}@test.com`;

test.describe("Auth deactivation propagates to downstream service (fail-close)", () => {
  test.use({ storageState: storageStatePath("admin") });

  const adminHeaders = {
    "Content-Type": "application/json",
    Cookie: getAuthCookie("admin"),
  };

  let userId;

  test.afterAll(async () => {
    // Idempotent cleanup: look up by email and delete if still present.
    try {
      const usersRes = await fetch(`${BASE_URL}/auth/api/users`, { headers: adminHeaders });
      const users = await usersRes.json();
      const u = users.find((x) => x.email === TEST_EMAIL);
      if (u) {
        await fetch(`${BASE_URL}/auth/api/users/${u.id}`, {
          method: "DELETE",
          headers: adminHeaders,
        });
      }
    } catch { /* ignore */ }
  });

  test("active student is accepted, then rejected by documents after deactivation", async () => {
    // 1. Admin creates a student user in auth.
    const createRes = await fetch(`${BASE_URL}/auth/api/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ email: TEST_EMAIL, role: "student" }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    userId = created.id;
    expect(userId).toBeTruthy();

    // 2. Forge this user's session cookie (mirrors what auth would set on login).
    //    The downstream service trusts the signature, then re-validates against
    //    the auth service on every request — that re-validation is what we're testing.
    const studentJwt = createJWT(
      { email: TEST_EMAIL, name: "E2E Deactivation User", role: "student", accessRevision: 0 },
      JWT_SECRET,
    );
    const studentCookie = `fsk_session=${studentJwt}`;

    // 3. While ACTIVE: the student can use documents self-service.
    const okRes = await fetch(`${BASE_URL}/competition/api/v1/documents/sessions`, {
      headers: { Cookie: studentCookie },
    });
    expect(okRes.status).toBe(200);

    // Sanity: confirm Auth still lists the account as active.
    const usersOkRes = await fetch(`${BASE_URL}/auth/api/users`, { headers: adminHeaders });
    expect(usersOkRes.status).toBe(200);
    const activeUser = (await usersOkRes.json()).find((user) => user.email === TEST_EMAIL);
    expect(activeUser).toMatchObject({ role: "student", active: 1 });

    // 4. Admin DEACTIVATES the user in auth (active = false).
    const deactivateRes = await fetch(`${BASE_URL}/auth/api/users/${userId}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ active: false }),
    });
    expect(deactivateRes.status).toBe(200);

    // 5. Auth exposes the account as inactive to its management API.
    await expect.poll(async () => {
      const res = await fetch(`${BASE_URL}/auth/api/users`, { headers: adminHeaders });
      const users = await res.json();
      return users.find((user) => user.email === TEST_EMAIL)?.active;
    }, { timeout: 10000 }).toBe(0);

    // 6. The NEXT documents request with the SAME (still cryptographically valid) JWT
    //    is now rejected: validateUser → 404 → req.user nulled → 401 on API route.
    await expect.poll(async () => {
      const res = await fetch(`${BASE_URL}/competition/api/v1/documents/sessions`, {
        headers: { Cookie: studentCookie },
      });
      return res.status;
    }, { timeout: 10000 }).toBe(401);

    // 7. Re-ACTIVATE and confirm the same token is accepted again — proving the
    //    rejection was caused by the active flag, not token expiry/corruption.
    const reactivateRes = await fetch(`${BASE_URL}/auth/api/users/${userId}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ active: true }),
    });
    expect(reactivateRes.status).toBe(200);

    await expect.poll(async () => {
      const res = await fetch(`${BASE_URL}/competition/api/v1/documents/sessions`, {
        headers: { Cookie: studentCookie },
      });
      return res.status;
    }, { timeout: 10000 }).toBe(200);
  });
});
