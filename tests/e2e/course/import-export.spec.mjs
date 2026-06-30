import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// Course export → import round-trip at the API level (admin). Export returns
// { name, cones:[{lat,lng,side}] }; import creates a brand-new course from that
// shape. Names are unique per run; a duplicate-name import must fail the UNIQUE
// constraint.

test.use({ storageState: storageStatePath("admin") });

test.describe("Course import / export", () => {
  const created = [];

  test.afterEach(async ({ page }) => {
    for (const id of created.splice(0)) {
      await page.request.delete(`/course/api/courses/${id}`);
    }
  });

  test("export then re-import preserves the cone set; duplicate name fails", async ({ page }) => {
    // Seed a source course with a known cone set.
    const srcName = `e2e-io-src-${Date.now()}-${test.info().parallelIndex}`;
    const srcRes = await page.request.post("/course/api/courses", { data: { name: srcName } });
    expect(srcRes.status()).toBe(201);
    const srcId = (await srcRes.json()).id;
    created.push(srcId);

    const seeds = [
      { lat: 37.5, lng: 127.0, side: "left" },
      { lat: 37.5001, lng: 127.0001, side: "center" },
      { lat: 37.5002, lng: 127.0002, side: "right" },
    ];
    for (const c of seeds) {
      const r = await page.request.post(`/course/api/courses/${srcId}/cones`, { data: c });
      expect(r.status()).toBe(201);
    }

    // Export → { name, cones:[...] } with the right count.
    const exportRes = await page.request.get(`/course/api/courses/${srcId}/export`);
    expect(exportRes.ok()).toBeTruthy();
    const exported = await exportRes.json();
    expect(exported.name).toBe(srcName);
    expect(Array.isArray(exported.cones)).toBeTruthy();
    expect(exported.cones.length).toBe(seeds.length);

    // Import as a new uniquely-named course from the exported cones → 201.
    const importName = `e2e-io-imp-${Date.now()}-${test.info().parallelIndex}`;
    const importRes = await page.request.post("/course/api/courses/import", {
      data: { name: importName, cones: exported.cones },
    });
    expect(importRes.status()).toBe(201);
    const importedCourse = await importRes.json();
    expect(importedCourse.name).toBe(importName);
    created.push(importedCourse.id);

    // The new course holds the same number of cones.
    const conesRes = await page.request.get(`/course/api/courses/${importedCourse.id}/cones`);
    expect(conesRes.ok()).toBeTruthy();
    expect((await conesRes.json()).length).toBe(seeds.length);

    // Importing again with the SAME name violates the UNIQUE(name) constraint.
    const dupRes = await page.request.post("/course/api/courses/import", {
      data: { name: importName, cones: exported.cones },
    });
    expect(dupRes.ok()).toBeFalsy();
    expect(dupRes.status()).toBe(400);
  });
});
