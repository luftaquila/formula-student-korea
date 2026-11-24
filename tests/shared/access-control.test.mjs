import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCESS_CONTROL_DEFINITIONS,
  DEVICE_SCOPES,
  HUMAN_ROLES,
  PERMISSION_KEYS,
  PERMISSION_DEFINITIONS,
  access,
  accessCatalog,
  authorizePrincipal,
  disabledGrants,
  enabledDeviceScopes,
  expandPermissions,
  normalizeAccessGrants,
  permissionFeature,
} from "../../shared/common/access-control.js";
import { SITE_FEATURE_NAMES } from "../../shared/common/site-features.js";

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
  // Admin-only tools are not grantable: Account & Access, Entry, Email/SMS, system logs.
  for (const retired of ["applications.manage", "contacts.manage", "entry.manage", "messaging.operate", "audit.view"]) {
    assert.equal(PERMISSION_KEYS.includes(retired), false);
  }
  assert.equal(ACCESS_CONTROL_DEFINITIONS.some(({ key }) => ["entry", "messaging", "audit"].includes(key)), false);
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

test("every permission belongs to a site feature and implies only its own feature", () => {
  for (const permission of PERMISSION_DEFINITIONS) {
    assert.ok(SITE_FEATURE_NAMES.includes(permission.feature), permission.key);
    for (const implied of permission.implies) assert.equal(permissionFeature(implied), permission.feature);
  }
  assert.equal(permissionFeature("rover.operate"), "course");
  assert.equal(permissionFeature("files.access"), "files");
  assert.throws(() => permissionFeature("queue.unknown"), /Unknown permission/);
});

test("the grant catalog lists only the permissions of enabled features", () => {
  const all = accessCatalog(SITE_FEATURE_NAMES);
  assert.deepEqual(all.permissions.map(({ key }) => key), PERMISSION_KEYS);
  assert.deepEqual(all.accessControls.map(({ key }) => key), ACCESS_CONTROL_DEFINITIONS.map(({ key }) => key));

  const documents = accessCatalog(["entry", "documents", "email"]);
  assert.deepEqual(documents.permissions.map(({ key }) => key), ["documents.operate", "documents.manage"]);
  assert.deepEqual(documents.accessControls.map(({ key }) => key), ["documents"]);
  assert.deepEqual(documents.roles, HUMAN_ROLES);

  const course = accessCatalog(["course"]);
  assert.deepEqual(course.accessControls.map(({ key }) => key), ["course", "rover"]);

  assert.deepEqual(disabledGrants(["documents.manage", "queue.operate", "files.access"], ["documents"]),
    ["queue.operate", "files.access"]);
});

test("kiosk scopes follow the queue features", () => {
  assert.deepEqual(enabledDeviceScopes(SITE_FEATURE_NAMES), DEVICE_SCOPES);
  assert.deepEqual(enabledDeviceScopes(["entry", "registration", "email"]), ["kiosk.registration.register"]);
  assert.deepEqual(enabledDeviceScopes(["entry", "documents", "email"]), []);
});
