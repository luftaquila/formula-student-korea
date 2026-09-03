import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanup,
  createClient,
  makeAuthCookie,
  setupTestEnv,
  startServer,
  stopServer,
  TEST_INTERNAL_SECRET,
  tmpDbPath,
} from "../helpers/test-utils.mjs";

setupTestEnv();
process.env.ADMIN_EMAIL = "access-admin@test.com";

import { createAuthApp } from "../../auth/index.mjs";

const adminCookie = makeAuthCookie({
  email: "access-admin@test.com",
  name: "Access Admin",
  role: "admin",
});

let dbPath;
let db;
let server;
let client;

before(async () => {
  dbPath = tmpDbPath();
  const auth = createAuthApp({ dbPath });
  db = auth.db;
  const started = await startServer(auth.app);
  server = started.server;
  client = createClient(started.baseUrl);
});

after(async () => {
  await stopServer(server);
  db.close();
  cleanup(dbPath);
});

describe("official access grants", () => {
  it("uses revisioned bundle/direct grants and clears them when the role changes", async () => {
    const created = await client.post("/api/users", {
      cookie: adminCookie,
      body: { email: "operator@test.com", role: "official" },
    });
    assert.equal(created.status, 201);
    const user = await created.json();

    const catalogResponse = await client.get("/api/access/catalog", { cookie: adminCookie });
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.deepEqual(catalog.roles, ["student", "official", "admin"]);
    assert.ok(catalog.permissions.some(({ key }) => key === "queue.manage"));
    assert.ok(catalog.permissions.some(({ key }) => key === "inspection.manage"));

    const updated = await client.put(`/api/users/${user.id}/access`, {
      cookie: adminCookie,
      body: {
        expectedRevision: 0,
        bundles: ["queue_manager"],
        directPermissions: ["inspection.operate"],
      },
    });
    assert.equal(updated.status, 200);
    const access = await updated.json();
    assert.equal(access.accessRevision, 1);
    assert.deepEqual(access.bundles, ["queue_manager"]);
    assert.deepEqual(access.directPermissions, ["inspection.operate"]);
    assert.ok(access.permissions.includes("queue.manage"));
    assert.ok(access.permissions.includes("queue.operate"));
    assert.ok(access.permissions.includes("inspection.operate"));
    assert.equal(access.permissions.includes("inspection.manage"), false);

    const authoritative = await client.get("/api/users/access/operator@test.com", {
      headers: { "X-Internal-Service": TEST_INTERNAL_SECRET },
    });
    assert.equal(authoritative.status, 200);
    assert.deepEqual((await authoritative.json()).permissions, access.permissions);

    const operatorCookie = makeAuthCookie({
      email: "operator@test.com", name: "Operator", role: "official",
    });
    assert.equal((await client.get("/api/admin/logs?service=auth", { cookie: operatorCookie })).status, 403);

    const auditorCreated = await client.post("/api/users", {
      cookie: adminCookie,
      body: { email: "auditor@test.com", role: "official" },
    });
    const auditor = await auditorCreated.json();
    const auditorAccess = await client.put(`/api/users/${auditor.id}/access`, {
      cookie: adminCookie,
      body: { expectedRevision: 0, bundles: ["auditor"], directPermissions: [] },
    });
    assert.equal(auditorAccess.status, 200);
    const auditorCookie = makeAuthCookie({
      email: "auditor@test.com", name: "Auditor", role: "official",
    });
    assert.equal((await client.get("/api/admin/logs?service=auth", { cookie: auditorCookie })).status, 200);

    const stale = await client.put(`/api/users/${user.id}/access`, {
      cookie: adminCookie,
      body: { expectedRevision: 0, bundles: [], directPermissions: [] },
    });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.equal(staleBody.code, "ACCESS_STALE_WRITE");
    assert.equal(staleBody.current.accessRevision, 1);

    const invalid = await client.put(`/api/users/${user.id}/access`, {
      cookie: adminCookie,
      body: { expectedRevision: 1, bundles: ["unknown_bundle"], directPermissions: [] },
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, "INVALID_ACCESS_KEY");

    const roleChange = await client.patch(`/api/users/${user.id}`, {
      cookie: adminCookie,
      body: { role: "student" },
    });
    assert.equal(roleChange.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_permission_bundle WHERE user_id = ?").get(user.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_permission WHERE user_id = ?").get(user.id).count, 0);

    const noLongerOfficial = await client.put(`/api/users/${user.id}/access`, {
      cookie: adminCookie,
      body: { expectedRevision: 2, bundles: [], directPermissions: [] },
    });
    assert.equal(noLongerOfficial.status, 409);
    assert.equal((await noLongerOfficial.json()).code, "OFFICIAL_ACCESS_ONLY");

    const rejectedUpdates = db.prepare(
      "SELECT detail FROM logs WHERE action = 'user.access_update' AND level = 'warn' ORDER BY id",
    ).all().map((row) => JSON.parse(row.detail));
    assert.ok(rejectedUpdates.some(({ reason }) => reason === "stale_write"));
    assert.ok(rejectedUpdates.some(({ reason }) => reason === "invalid_access_key"));
    assert.ok(rejectedUpdates.some(({ reason }) => reason === "official_only"));
  });
});

describe("kiosk device pairing", () => {
  it("issues one exact scope, stores only the token hash, and revokes immediately", async () => {
    const invalidScope = await client.post("/api/devices", {
      cookie: adminCookie,
      body: { name: "Invalid tablet", scope: "inspection.operate" },
    });
    assert.equal(invalidScope.status, 400);
    assert.equal((await invalidScope.json()).code, "INVALID_DEVICE_SCOPE");

    const missingPairingCode = await client.post("/api/devices/missing-device/pairing-code", {
      cookie: adminCookie,
    });
    assert.equal(missingPairingCode.status, 404);
    const missingRevoke = await client.post("/api/devices/missing-device/revoke", { cookie: adminCookie });
    assert.equal(missingRevoke.status, 404);

    const rejectedDeviceChanges = db.prepare(
      "SELECT action, detail FROM logs WHERE action IN ('device.create', 'device.pairing_code', 'device.revoke') AND level = 'warn' ORDER BY id",
    ).all().map((row) => ({ action: row.action, detail: JSON.parse(row.detail) }));
    assert.ok(rejectedDeviceChanges.some(({ action, detail }) => action === "device.create" && detail.reason === "invalid_scope"));
    assert.ok(rejectedDeviceChanges.some(({ action, detail }) => action === "device.pairing_code" && detail.reason === "not_found"));
    assert.ok(rejectedDeviceChanges.some(({ action, detail }) => action === "device.revoke" && detail.reason === "not_found"));

    const created = await client.post("/api/devices", {
      cookie: adminCookie,
      body: { name: "Queue tablet", scope: "kiosk.queue.register" },
    });
    assert.equal(created.status, 201);
    const device = await created.json();
    assert.match(device.pairingCode, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);

    const beforePair = db.prepare("SELECT token_hash, scope FROM kiosk_device WHERE id = ?").get(device.id);
    assert.equal(beforePair.token_hash, null);
    assert.equal(beforePair.scope, "kiosk.queue.register");

    const wrongCode = await client.post("/api/device/pair", { body: { code: "22222222" } });
    assert.equal(wrongCode.status, 401);

    const paired = await client.post("/api/device/pair", { body: { code: device.pairingCode } });
    assert.equal(paired.status, 200);
    assert.deepEqual(await paired.json(), {
      id: device.id,
      name: "Queue tablet",
      scope: "kiosk.queue.register",
      startPath: "/queue/register",
    });
    const setCookie = paired.headers.get("set-cookie") || "";
    const tokenMatch = setCookie.match(/fsk_device=([^;]+)/);
    assert.ok(tokenMatch, "pairing must set an HttpOnly device cookie");
    assert.match(setCookie, /SameSite=Strict/);
    const token = decodeURIComponent(tokenMatch[1]);
    assert.ok(token.length >= 32);

    const stored = db.prepare("SELECT token_hash, pairing_code_hash FROM kiosk_device WHERE id = ?").get(device.id);
    assert.notEqual(stored.token_hash, token);
    assert.equal(stored.pairing_code_hash, null);

    const replay = await client.post("/api/device/pair", { body: { code: device.pairingCode } });
    assert.equal(replay.status, 401);

    const session = await client.get("/api/device/session", { cookie: `fsk_device=${token}` });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).scope, "kiosk.queue.register");

    const validated = await client.post("/api/devices/validate", {
      headers: {
        "X-Internal-Service": TEST_INTERNAL_SECRET,
        "X-Device-Token": token,
      },
    });
    assert.equal(validated.status, 200);
    assert.equal((await validated.json()).id, device.id);

    const adminDenied = await client.get("/api/devices", { cookie: `fsk_device=${token}` });
    assert.equal(adminDenied.status, 403);

    const repaired = await client.post(`/api/devices/${device.id}/pairing-code`, { cookie: adminCookie });
    assert.equal(repaired.status, 200);
    const newPairingCode = (await repaired.json()).pairingCode;
    const oldSession = await client.get("/api/device/session", { cookie: `fsk_device=${token}` });
    assert.equal(oldSession.status, 401);
    const pairedAgain = await client.post("/api/device/pair", { body: { code: newPairingCode } });
    assert.equal(pairedAgain.status, 200);
    const newTokenMatch = (pairedAgain.headers.get("set-cookie") || "").match(/fsk_device=([^;]+)/);
    assert.ok(newTokenMatch);
    const newToken = decodeURIComponent(newTokenMatch[1]);
    assert.notEqual(newToken, token);

    const revoked = await client.post(`/api/devices/${device.id}/revoke`, { cookie: adminCookie });
    assert.equal(revoked.status, 200);

    const revokedSession = await client.get("/api/device/session", { cookie: `fsk_device=${newToken}` });
    assert.equal(revokedSession.status, 401);
    const revokedValidation = await client.post("/api/devices/validate", {
      headers: {
        "X-Internal-Service": TEST_INTERNAL_SECRET,
        "X-Device-Token": newToken,
      },
    });
    assert.equal(revokedValidation.status, 404);
  });
});
