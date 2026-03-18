import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";
import { getAuthCookie, BASE_URL } from "../helpers/auth.mjs";

const YEAR = new Date().getFullYear();

test.describe("Entry → Documents team_num sync", () => {
  test.use({ storageState: storageStatePath("admin") });

  const headers = {
    "Content-Type": "application/json",
    Cookie: getAuthCookie("admin"),
  };
  const chiefHeaders = {
    "Content-Type": "application/json",
    Cookie: getAuthCookie("chief"),
  };

  test("changing entry number syncs team_num in documents service", async ({ page }) => {
    // 1. Verify documents student-team mapping shows team_num=1
    const mappingsBefore = await fetch(
      `${BASE_URL}/documents/api/admin/student-teams?year=${YEAR}`,
      { headers: chiefHeaders },
    );
    expect(mappingsBefore.status).toBe(200);
    const dataBefore = await mappingsBefore.json();
    const team1Before = dataBefore.find((m) => m.team_num === 1);
    expect(team1Before).toBeTruthy();

    // 2. Change entry 1's number to 99
    const patchRes = await fetch(`${BASE_URL}/entry/api/entries/1?year=${YEAR}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ num: 99, univ: "서울대학교", team: "SNU Racing", type: "EV" }),
    });
    expect(patchRes.status).toBe(200);

    // 3. Wait briefly for async inter-service call to complete
    await page.waitForTimeout(500);

    // 4. Verify documents student-team mapping now shows team_num=99
    const mappingsAfter = await fetch(
      `${BASE_URL}/documents/api/admin/student-teams?year=${YEAR}`,
      { headers: chiefHeaders },
    );
    expect(mappingsAfter.status).toBe(200);
    const dataAfter = await mappingsAfter.json();
    const team99 = dataAfter.find((m) => m.team_num === 99);
    expect(team99).toBeTruthy();
    const team1After = dataAfter.find((m) => m.team_num === 1);
    expect(team1After).toBeFalsy();

    // 5. Verify via the admin page UI
    await page.goto("/documents/admin");
    await waitForPageReady(page);

    // The student-team table should show team_num=99
    const mappingTable = page.locator(".student-teams-table, table").first();
    await expect(mappingTable).toContainText("99", { timeout: 5000 });

    // 6. Clean up: change entry number back to 1
    const restoreRes = await fetch(`${BASE_URL}/entry/api/entries/99?year=${YEAR}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ num: 1, univ: "서울대학교", team: "SNU Racing", type: "EV" }),
    });
    expect(restoreRes.status).toBe(200);

    // Wait for sync
    await page.waitForTimeout(500);

    // Verify restoration
    const mappingsRestored = await fetch(
      `${BASE_URL}/documents/api/admin/student-teams?year=${YEAR}`,
      { headers: chiefHeaders },
    );
    const dataRestored = await mappingsRestored.json();
    expect(dataRestored.find((m) => m.team_num === 1)).toBeTruthy();
  });
});
