import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Submission input validation, kept STATELESS to stay flake-free in the shared
// documents shard. It submits to the seeded open session ("E2E 테스트 세션",
// teams [1,2,3], current year) with NO file: the request is rejected (400) before
// anything is persisted or broadcast, so it never churns the submission/session
// state the dashboard specs (admin-download, admin-prev-submission, …) assert on.
//
// Retention-to-2, attempt_no growth, and inline-vs-attachment disposition all
// require PERSISTED submissions by the lone seeded team-1 student, which would
// race those dashboard specs running concurrently in this shard. They are left to
// unit coverage rather than introduce a cross-spec flake.
test.describe("Documents submission validation", () => {
  test.use({ storageState: storageStatePath("student") });

  test("submission with no file is rejected (400)", async ({ page }) => {
    const list = await page.request.get("/documents/api/sessions");
    expect(list.ok()).toBeTruthy();
    const { sessions } = await list.json();
    const session = sessions.find((s) => s.name === "E2E 테스트 세션") || sessions[0];
    test.skip(!session, "no session available to the seeded student");

    // multipart with no file field → busboy finishes with 0 files → 400.
    const res = await page.request.post(`/documents/api/sessions/${session.id}/submit`, {
      multipart: { note: "no actual file here" },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain("파일을 선택");
  });
});
