import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  tmpDbPath,
  makeAuthCookie,
  createClient,
  startServer,
  stopServer,
  cleanup,
  setupTestEnv,
} from '../helpers/test-utils.mjs';

setupTestEnv();
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

import { createAuthApp } from '../../auth/index.mjs';

// Regression guard for the transaction-rollback logging fix.
//
// The last-admin guards (user.bulk_delete, user.update) throw INSIDE a
// db.transaction(). The logger writes to the same SQLite connection, so a
// warn emitted before the throw would be undone by the rollback the throw
// triggers — leaving the denial untraceable. The fix records the reason via
// an out-of-transaction flag and logs after the transaction settles. This
// test fails if the warn is ever moved back inside the transaction.
describe('last-admin guard: warn survives transaction rollback', () => {
  let server, baseUrl, client, db, dbPath, savedAdminEmail;

  before(async () => {
    // No ADMIN_EMAIL → no protected/bootstrap admin, so a lone admin is
    // actually deletable and the in-transaction last_admin branch is reached.
    savedAdminEmail = process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_EMAIL;

    dbPath = tmpDbPath();
    const result = createAuthApp({ dbPath });
    db = result.db;
    // Seed exactly one admin directly: the API needs an existing admin to
    // authenticate, and this is the very admin we then try to delete.
    db.prepare("INSERT INTO users (email, role) VALUES (?, 'admin')").run('solo-admin@test.com');

    const started = await startServer(result.app);
    server = started.server;
    baseUrl = started.baseUrl;
    client = createClient(baseUrl);
  });

  after(async () => {
    await stopServer(server);
    db.close();
    cleanup(dbPath);
    if (savedAdminEmail !== undefined) process.env.ADMIN_EMAIL = savedAdminEmail;
    else delete process.env.ADMIN_EMAIL;
  });

  it('logs a user.bulk_delete warn when the rolled-back tx blocks last-admin deletion', async () => {
    const soloCookie = makeAuthCookie({ email: 'solo-admin@test.com', name: 'Solo', role: 'admin' });
    const soloId = db.prepare("SELECT id FROM users WHERE email = ?").get('solo-admin@test.com').id;

    const res = await client.delete('/api/users/bulk', { body: { ids: [soloId] }, cookie: soloCookie });
    assert.equal(res.status, 400, 'deleting the last admin must be rejected');

    // The admin must still exist (transaction rolled back) ...
    const stillThere = db.prepare("SELECT 1 FROM users WHERE id = ?").get(soloId);
    assert.ok(stillThere, 'last admin should not have been deleted');

    // ... and the warn must have persisted despite that rollback.
    const row = db
      .prepare("SELECT * FROM logs WHERE action = 'user.bulk_delete' AND level = 'warn' ORDER BY id DESC LIMIT 1")
      .get();
    assert.ok(row, 'expected a persisted warn log for the blocked last-admin deletion');
    assert.match(row.detail, /last_admin/, 'warn detail should record the last_admin reason');
  });
});
