import { test, expect } from "@playwright/test";
import { storageStatePath } from "../helpers/utils.mjs";

// The signed iCal feed is the only unauthenticated data-export path. The
// subscribe URL binds an HMAC signature to the caller's audience, and the feed
// itself returns only events visible to that audience. Tamper/forge must be rejected.
const PREFIX = `ical-${Date.now()}-`;
let adminCtx;
const created = [];
const pubTitle = `${PREFIX}public`;
const officialTitle = `${PREFIX}official`;

test.beforeAll(async ({ browser }) => {
  adminCtx = await browser.newContext({ storageState: storageStatePath("admin") });
  for (const [title, role] of [[pubTitle, "public"], [officialTitle, "official"]]) {
    const res = await adminCtx.request.post("/calendar/api/events", {
      data: { title, start: "2099-01-01", end: "2099-01-01", allDay: true, role },
    });
    expect(res.status()).toBe(201);
    created.push((await res.json()).id);
  }
});

test.afterAll(async () => {
  for (const id of created) await adminCtx.request.delete(`/calendar/api/events/${id}`);
  await adminCtx.close();
});

async function subscribePath(role) {
  const ctx = await adminCtx.browser().newContext({ storageState: storageStatePath(role) });
  const res = await ctx.request.get("/calendar/api/events/subscribe");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  await ctx.close();
  return body;
}

test("subscribe returns an audience-scoped signed URL", async () => {
  const sub = await subscribePath("student");
  expect(sub.role).toBe("student");
  expect(sub.path).toContain("role=student");
  expect(sub.path).toMatch(/sig=[0-9a-f]+/);
});

test("subscribe signature is bound to the role (student URL ≠ admin URL)", async () => {
  const student = await subscribePath("student");
  const admin = await subscribePath("admin");
  expect(student.path).not.toBe(admin.path);
});

test("anonymous cannot subscribe (student+ only)", async ({ request }) => {
  const res = await request.get("/calendar/api/events/subscribe");
  expect(res.status()).toBe(401);
});

test("valid signed feed returns only events visible to the subscribed audience", async ({ request }) => {
  const sub = await subscribePath("student");
  const res = await request.get(sub.path);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/calendar");
  const body = await res.text();
  expect(body).toContain("BEGIN:VCALENDAR");
  expect(body).toContain(pubTitle);
  expect(body).not.toContain(officialTitle);
});

test("tampered signature → 403", async ({ request }) => {
  const sub = await subscribePath("student");
  const tampered = sub.path.replace(/sig=([0-9a-f]+)/, (_, s) => `sig=${s.slice(0, -1)}${s.endsWith("a") ? "b" : "a"}`);
  const res = await request.get(tampered);
  expect(res.status()).toBe(403);
});

test("missing role/sig params → 400", async ({ request }) => {
  const res = await request.get("/calendar/api/events/ical");
  expect(res.status()).toBe(400);
});
