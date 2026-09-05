import assert from "node:assert/strict";
import test from "node:test";
import {
  getIcon,
  operations,
  administration,
  resources,
  services,
} from "../../shared/nav-config.js";
import { ROLE_SORT_ORDER } from "../../shared/constants.js";
import { ACCESS_CONTROL_DEFINITIONS, PERMISSION_KEYS } from "../../shared/access-control.js";

test("participant navigation has one queue lookup while registration operations stay separate", () => {
  const queue = services.find((item) => item.href === "/queue");
  const registrationAdmin = operations.find((item) => item.href === "/registration/manage");

  assert.equal(queue?.name, "대기열 조회");
  assert.equal(services.some((item) => item.href === "/registration"), false);
  assert.equal(registrationAdmin?.name, "등록 대기 관리");
  assert.equal(getIcon(queue?.icon), "🔧");
  assert.equal(getIcon(registrationAdmin?.icon), "🎛️");

  const menuItems = [...services, ...resources, ...operations, ...administration];
  const otherIcons = menuItems
    .filter((item) => item !== registrationAdmin)
    .map((item) => getIcon(item.icon));
  assert.equal(otherIcons.includes(getIcon(registrationAdmin.icon)), false);
});

test("human roles and operation links expose only explicit permissions", () => {
  const registrationAdmin = operations.find((item) => item.href === "/registration/manage");
  assert.deepEqual(ROLE_SORT_ORDER, { student: 1, official: 2, admin: 3 });
  assert.equal(registrationAdmin.permission, "registration.operate");
  assert.equal(operations.find((item) => item.href === "/queue/admin")?.permission, "queue.operate");
  assert.equal(operations.find((item) => item.href === "/inspection")?.permission, "inspection.operate");
  assert.ok(operations.every((item) => item.permission && PERMISSION_KEYS.includes(item.permission)));

  assert.deepEqual(administration.map((item) => item.href), ["/entry", "/email", "/auth/logs", "/auth"]);
  assert.ok(administration.every((item) => item.adminOnly && !item.permission));
  for (const href of administration.map((item) => item.href)) {
    assert.equal(operations.some((item) => item.href === href), false);
  }

  const registrationAccess = ACCESS_CONTROL_DEFINITIONS.find(({ key }) => key === "registration");
  assert.equal(registrationAccess?.type, "tiered");
  assert.equal(registrationAccess?.operate.key, "registration.operate");
  assert.equal(registrationAccess?.manage.key, "registration.manage");
});
