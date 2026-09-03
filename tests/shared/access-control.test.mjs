import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCESS_CONTROL_DEFINITIONS,
  DEVICE_SCOPES,
  HUMAN_ROLES,
  PERMISSION_KEYS,
  access,
  authorizePrincipal,
  expandPermissions,
  normalizeAccessGrants,
} from "../../shared/access-control.js";

test("uses only student, official, and admin as human roles", () => {
  assert.deepEqual(HUMAN_ROLES, ["student", "official", "admin"]);
});

test("keeps Queue and Inspection operation and management grants independent", () => {
  const queue = expandPermissions(["queue.manage"]);
  assert.ok(queue.includes("queue.manage"));
  assert.ok(queue.includes("queue.operate"));
  assert.equal(queue.some((permission) => permission.startsWith("inspection.")), false);

  const inspection = expandPermissions(["inspection.manage"]);
  assert.ok(inspection.includes("inspection.manage"));
  assert.ok(inspection.includes("inspection.operate"));
  assert.equal(inspection.some((permission) => permission.startsWith("queue.")), false);
});

test("five services use three levels while Course and Score are full-access toggles", () => {
  assert.deepEqual(
    ACCESS_CONTROL_DEFINITIONS.filter(({ type }) => type === "tiered").map(({ key }) => key),
    ["registration", "queue", "inspection", "documents", "traffic"],
  );
  for (const key of ["course", "score"]) {
    const control = ACCESS_CONTROL_DEFINITIONS.find((candidate) => candidate.key === key);
    assert.equal(control.type, "toggle");
    assert.equal(control.permission, `${key}.manage`);
  }
});

test("management implies operation and stored grants have one canonical source", () => {
  for (const service of ["registration", "queue", "inspection", "documents", "course", "traffic", "score"]) {
    const effective = expandPermissions([`${service}.manage`]);
    assert.ok(effective.includes(`${service}.operate`));
  }
  assert.deepEqual(
    normalizeAccessGrants(["queue.operate", "queue.manage", "course.operate", "score.operate"]),
    ["course.manage", "queue.manage", "score.manage"],
  );
  assert.deepEqual(normalizeAccessGrants(["rover.operate"]), ["rover.operate"]);
  assert.deepEqual(expandPermissions(["rover.operate"]), ["course.operate", "rover.operate"]);
});

test("admin bypass applies only to human permissions and kiosk scopes remain exact", () => {
  assert.equal(authorizePrincipal({ kind: "human", role: "admin", permissions: [] }, access.permission("queue.manage")), true);
  assert.equal(authorizePrincipal({ kind: "device", scope: DEVICE_SCOPES[0] }, access.permission("queue.operate")), false);
  assert.equal(authorizePrincipal({ kind: "device", scope: "kiosk.queue.register" }, access.device("kiosk.queue.register")), true);
  assert.equal(authorizePrincipal({ kind: "device", scope: "kiosk.queue.register" }, access.device("kiosk.registration.register")), false);
});
