import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createClient, makeAuthCookie, setupTestEnv, startServer, stopServer, testSite, TRUST_JWT,
} from "../helpers/test-utils.mjs";
import { validateCompetitionDatabase } from "../../competition/lib/database-validation.mjs";

setupTestEnv();
const { createCompetitionApp } = await import("../../competition/index.mjs");

const adminCookie = makeAuthCookie({ email: "features-admin@test.com", name: "Admin", role: "admin" });
const roots = [];

after(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Stands in for the Email service's SMS configuration endpoint.
function smsConfigFetch(requests) {
  return async (url) => {
    requests.push(String(url));
    return {
      ok: true,
      json: async () => ({
        naver_cloud_access_key: "key",
        naver_cloud_secret_key: "secret",
        naver_cloud_sms_service_id: "service",
        phone_number_sms_sender: "01000000000",
      }),
    };
  };
}

async function startCompetition(features, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-site-features-"));
  roots.push(root);
  const staticRoots = {};
  for (const name of ["entry", "queue", "registration", "inspection", "traffic", "score", "documents"]) {
    staticRoots[name] = path.join(root, name);
    fs.mkdirSync(staticRoots[name]);
    fs.writeFileSync(path.join(staticRoots[name], "index.html"),
      `<html><head><title>${name}</title></head><body>${name}</body></html>`);
  }
  const runtime = createCompetitionApp({
    dbPath: path.join(root, "competition.db"),
    uploadRoot: path.join(root, "uploads"),
    staticRoots,
    validateUser: TRUST_JWT,
    enableNotificationScheduler: false,
    site: testSite({ FEATURES: features }),
    ...options,
  });
  const { server, baseUrl } = await startServer(runtime.app);
  return {
    runtime,
    baseUrl,
    client: createClient(baseUrl),
    async stop() {
      await stopServer(server);
      await runtime.close();
    },
  };
}

describe("Competition modules follow the enabled site features", () => {
  it("serves only Registration and its public lookup on a registration deployment", async () => {
    const competition = await startCompetition("entry,registration,email");
    try {
      const { client } = competition;
      assert.equal((await client.get("/competition/api/v1/teams")).status, 200);
      assert.equal((await client.get("/competition/api/v1/registration/status")).status, 200);
      for (const module of ["queue", "inspection", "traffic", "score", "documents"]) {
        const response = await client.get(`/competition/api/v1/${module}/logs`, { cookie: adminCookie });
        assert.equal(response.status, 404, module);
      }

      const entry = await client.get("/entry/", { cookie: adminCookie });
      assert.equal(entry.status, 200);
      // The deployment's short name prefixes the packaged page title.
      assert.match(await entry.text(), /<title>TC entry<\/title>/);
      for (const prefix of ["/inspection/", "/traffic/", "/score/", "/documents/"]) {
        assert.equal((await client.get(prefix, { cookie: adminCookie })).status, 404, prefix);
      }

      // Registration's lookup page lives in the Queue SPA; the Queue operations do not.
      const hub = await client.get("/queue/");
      assert.equal(hub.status, 200);
      assert.match(await hub.text(), /<title>TC queue<\/title>/);
      for (const page of ["/queue/admin", "/queue/register", "/queue/settings", "/queue/stats"]) {
        assert.equal((await client.get(page, { cookie: adminCookie })).status, 404, page);
      }
      const registration = await fetch(`${competition.baseUrl}/registration/`, { redirect: "manual" });
      assert.equal(registration.status, 302);
      assert.equal(registration.headers.get("location"), "/queue/");
    } finally {
      await competition.stop();
    }
  });

  it("loads the shared SMS configuration for Registration without the Queue", async () => {
    const requests = [];
    const competition = await startCompetition("entry,registration,email", { fetchImpl: smsConfigFetch(requests) });
    try {
      await competition.runtime.start();
      assert.equal(requests.length, 1);
      const settings = await competition.client.get("/competition/api/v1/registration/settings", { cookie: adminCookie });
      assert.equal(settings.status, 200);
      assert.equal((await settings.json()).smsAvailable, true);
    } finally {
      await competition.stop();
    }
  });

  it("serves the Queue operations once the Queue feature is enabled", async () => {
    const competition = await startCompetition("entry,queue,email");
    try {
      const { client } = competition;
      assert.equal((await client.get("/queue/admin", { cookie: adminCookie })).status, 200);
      assert.equal((await client.get("/competition/api/v1/queue/active")).status, 200);
      assert.equal((await client.get("/competition/api/v1/registration/status")).status, 404);
      assert.equal((await client.get("/registration/manage", { cookie: adminCookie })).status, 404);
    } finally {
      await competition.stop();
    }
  });

  it("keeps one database contract for a documents deployment and loads no SMS configuration", async () => {
    const requests = [];
    const competition = await startCompetition("entry,documents,email", { fetchImpl: smsConfigFetch(requests) });
    try {
      const { runtime, client } = competition;
      assert.equal((await client.get("/documents/admin", { cookie: adminCookie })).status, 200);
      assert.equal((await client.get("/queue/")).status, 404);
      assert.equal((await client.get("/registration/")).status, 404);
      // Every module schema exists even though only Documents serves requests.
      validateCompetitionDatabase(runtime.db);
      await runtime.start();
      assert.deepEqual(requests, []);
    } finally {
      await competition.stop();
    }
  });
});
