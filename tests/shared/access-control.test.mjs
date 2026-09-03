import assert from "node:assert/strict";
import test from "node:test";
import {
  BUNDLE_DEFINITIONS,
  DEVICE_SCOPES,
  HUMAN_ROLES,
  PERMISSION_KEYS,
  access,
  authorizePrincipal,
  expandPermissions,
} from "../../shared/access-control.js";

test("uses only student, official, and admin as human roles", () => {
  assert.deepEqual(HUMAN_ROLES, ["student", "official", "admin"]);
});

test("keeps Queue and Inspection operation and management grants independent", () => {
  const queue = expandPermissions({ bundles: ["queue_manager"] });
  assert.ok(queue.includes("queue.manage"));
  assert.ok(queue.includes("queue.operate"));
  assert.equal(queue.some((permission) => permission.startsWith("inspection.")), false);

  const inspection = expandPermissions({ bundles: ["inspection_manager"] });
  assert.ok(inspection.includes("inspection.manage"));
  assert.ok(inspection.includes("inspection.operate"));
  assert.equal(inspection.some((permission) => permission.startsWith("queue.")), false);
});

test("every bundle references a known permission and management implies operation", () => {
  for (const bundle of BUNDLE_DEFINITIONS) {
    assert.ok(bundle.permissions.every((permission) => PERMISSION_KEYS.includes(permission)));
  }
  for (const service of ["registration", "queue", "inspection", "documents", "course", "traffic", "score"]) {
    const effective = expandPermissions({ directPermissions: [`${service}.manage`] });
    assert.ok(effective.includes(`${service}.operate`));
  }
});

test("admin bypass applies only to human permissions and kiosk scopes remain exact", () => {
  assert.equal(authorizePrincipal({ kind: "human", role: "admin", permissions: [] }, access.permission("queue.manage")), true);
  assert.equal(authorizePrincipal({ kind: "device", scope: DEVICE_SCOPES[0] }, access.permission("queue.operate")), false);
  assert.equal(authorizePrincipal({ kind: "device", scope: "kiosk.queue.register" }, access.device("kiosk.queue.register")), true);
  assert.equal(authorizePrincipal({ kind: "device", scope: "kiosk.queue.register" }, access.device("kiosk.registration.register")), false);
});
