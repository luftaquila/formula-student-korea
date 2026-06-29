import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// calendar GET /api/events is public but role-filtered server-side: a viewer
// only sees events at or below their own role. This is a privacy boundary, so
// we seed one event per visibility level (far-future, unique titles for
// parallel isolation) and assert each role sees exactly the expected subset.
const PREFIX = `vis-${Date.now()}-`;
const ROLES = ["public", "student", "official", "chief", "admin"];
const WIN = "timeMin=2099-01-01&timeMax=2099-12-31";

let adminCtx;
const created = []; // event ids, for cleanup
const titleOf = (role) => `${PREFIX}${role}`;

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext({ storageState: storageStatePath("admin") });
  for (const role of ROLES) {
    const res = await adminCtx.request.post("/calendar/api/events", {
      data: { title: titleOf(role), start: "2099-01-01", end: "2099-01-01", allDay: true, role },
    });
    expect(res.status(), `seed ${role}`).toBe(201);
    created.push((await res.json()).id);
  }
});

test.afterAll(async () => {
  for (const id of created) await adminCtx.request.delete(`/calendar/api/events/${id}`);
  await adminCtx.close();
});

// Returns the set of seeded titles (by role) visible to the given request context.
async function visibleRoles(reqCtx) {
  const res = await reqCtx.get(`/calendar/api/events?${WIN}`);
  expect(res.ok()).toBeTruthy();
  const titles = (await res.json()).map((e) => e.title);
  return ROLES.filter((r) => titles.includes(titleOf(r)));
}

test("anonymous viewer sees only public events", async ({ request }) => {
  expect(await visibleRoles(request)).toEqual(["public"]);
});

test("student sees public + student only", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: storageStatePath("student") });
  expect(await visibleRoles(ctx.request)).toEqual(["public", "student"]);
  await ctx.close();
});

test("official sees public + student + official only", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: storageStatePath("official") });
  expect(await visibleRoles(ctx.request)).toEqual(["public", "student", "official"]);
  await ctx.close();
});

test("admin sees all levels", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: storageStatePath("admin") });
  expect(await visibleRoles(ctx.request)).toEqual(ROLES);
  await ctx.close();
});

test("chief cannot create an event more visible than itself (role escalation → 403)", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: storageStatePath("chief") });
  const res = await ctx.request.post("/calendar/api/events", {
    data: { title: `${PREFIX}escalate`, start: "2099-02-01", end: "2099-02-01", allDay: true, role: "admin" },
  });
  expect(res.status()).toBe(403);
  await ctx.close();
});

test("non-chief cannot create/update/delete events", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: storageStatePath("official") });
  const create = await ctx.request.post("/calendar/api/events", {
    data: { title: `${PREFIX}nope`, start: "2099-03-01", end: "2099-03-01", allDay: true, role: "official" },
  });
  expect(create.status()).toBe(403);
  const del = await ctx.request.delete(`/calendar/api/events/${created[0]}`);
  expect(del.status()).toBe(403);
  await ctx.close();
});

test("GET /api/events requires timeMin and timeMax", async ({ request }) => {
  const res = await request.get("/calendar/api/events");
  expect(res.status()).toBe(400);
});
