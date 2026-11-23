import { test, expect } from "@playwright/test";
import { storageStatePath, waitForPageReady } from "../helpers/utils.mjs";

// The fsk-coursekeeper console tests its own editing tools. This covers what FSK
// adds as its host: edits made in the console go through the Course server and
// stay there. Each mutation is awaited on its API response (no fixed sleeps).

test.use({
  storageState: storageStatePath("admin"),
  viewport: { width: 1280, height: 800 },
});

const pathOf = (response) => new URL(response.url()).pathname;

test.describe("Course console host", () => {
  let courseId;

  test.afterEach(async ({ page }) => {
    if (courseId) await page.request.delete(`/course/api/courses/${courseId}`);
    courseId = null;
  });

  test("a course and cone edited in the console are stored on the Course server", async ({ page }) => {
    await page.goto("/course");
    await waitForPageReady(page);
    const map = page.getByTestId("map");
    await expect(map).toBeVisible();

    const name = `e2e-console-${Date.now()}-${test.info().parallelIndex}`;
    const switcher = page.getByTestId("course-switcher");
    await switcher.getByRole("button", { expanded: false }).click();
    const input = switcher.getByRole("textbox", { name: "New course name" });
    await input.fill(name);
    const created = page.waitForResponse((r) => pathOf(r) === "/course/api/courses" && r.request().method() === "POST");
    await input.press("Enter");
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    courseId = (await createdResponse.json()).id;
    await expect(switcher.getByRole("button").first()).toContainText(name);

    const addTool = page.getByTestId("palette").getByRole("button", { name: "Add cones", exact: true });
    await addTool.click();
    await expect(addTool).toHaveAttribute("aria-pressed", "true");
    const added = page.waitForResponse((r) => pathOf(r) === `/course/api/courses/${courseId}/cones` && r.request().method() === "POST");
    const box = await map.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 - 40);
    expect((await added).status()).toBe(201);

    const rows = page.getByTestId("cone-row");
    await expect(rows).toHaveCount(1);
    expect(await (await page.request.get(`/course/api/courses/${courseId}/cones`)).json()).toHaveLength(1);

    const deleted = page.waitForResponse((r) => /^\/course\/api\/cones\/\d+$/.test(pathOf(r)) && r.request().method() === "DELETE");
    await rows.first().getByRole("button", { name: /^Delete / }).click();
    expect((await deleted).status()).toBe(200);
    await expect(rows).toHaveCount(0);
    expect(await (await page.request.get(`/course/api/courses/${courseId}/cones`)).json()).toHaveLength(0);
  });
});
