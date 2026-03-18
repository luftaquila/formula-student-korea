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
  TEST_SECRET,
  TEST_INTERNAL_SECRET,
} from '../helpers/test-utils.mjs';

setupTestEnv();

import { createEntryApp } from '../../entry/index.mjs';

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });

let server, baseUrl, client, db, dbPath;

before(async () => {
  dbPath = tmpDbPath();
  const result = createEntryApp({ dbPath });
  db = result.db;
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  await stopServer(server);
  db.close();
  cleanup(dbPath);
});

// ─── Health & Years ──────────────────────────────────────────────────────
describe('GET /api/health', () => {
  it('returns 200 "ok"', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'ok');
  });
});

describe('GET /api/years', () => {
  it('returns array with current year', async () => {
    const res = await client.get('/api/years');
    assert.equal(res.status, 200);
    const years = await res.json();
    assert.ok(Array.isArray(years));
    assert.ok(years.includes(new Date().getFullYear()));
  });
});

// ─── Vehicle Types ───────────────────────────────────────────────────────
describe('GET /api/vehicle-types', () => {
  it('returns empty array initially', async () => {
    const res = await client.get('/api/vehicle-types');
    assert.equal(res.status, 200);
    const types = await res.json();
    assert.ok(Array.isArray(types));
    assert.equal(types.length, 0);
  });
});

describe('POST /api/vehicle-types', () => {
  it('creates a vehicle type (requires admin cookie)', async () => {
    const res = await client.post('/api/vehicle-types', {
      body: { name: 'EV' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.name, 'EV');
    assert.ok(data.id);
    assert.equal(data.sort_order, 0);
  });

  it('rejects empty name', async () => {
    const res = await client.post('/api/vehicle-types', {
      body: { name: '  ' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects duplicate name', async () => {
    const res = await client.post('/api/vehicle-types', {
      body: { name: 'EV' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('auto-increments sort_order', async () => {
    const res = await client.post('/api/vehicle-types', {
      body: { name: 'CV' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.name, 'CV');
    assert.equal(data.sort_order, 1);
  });
});

describe('DELETE /api/vehicle-types/:id', () => {
  it('deletes a vehicle type', async () => {
    // Create a disposable type
    const createRes = await client.post('/api/vehicle-types', {
      body: { name: 'Temp' },
      cookie: adminCookie,
    });
    const { id } = await createRes.json();

    const res = await client.delete(`/api/vehicle-types/${id}`, { cookie: adminCookie });
    assert.equal(res.status, 200);

    // Verify it's gone
    const listRes = await client.get('/api/vehicle-types');
    const types = await listRes.json();
    assert.ok(!types.find(t => t.id === id));
  });

  it('cascading: nullifies entries with that type', async () => {
    // Create a type and an entry with that type
    const typeRes = await client.post('/api/vehicle-types', {
      body: { name: 'Cascade' },
      cookie: adminCookie,
    });
    const typeData = await typeRes.json();

    await client.post('/api/entries', {
      body: { num: 900, univ: 'CascadeUniv', team: 'CascadeTeam', type: 'Cascade' },
      cookie: adminCookie,
    });

    // Delete the type
    await client.delete(`/api/vehicle-types/${typeData.id}`, { cookie: adminCookie });

    // Verify the entry's type is now null
    const entriesRes = await client.get('/api/entries');
    const entries = await entriesRes.json();
    assert.equal(entries[900].type, null);

    // Clean up the entry
    await client.delete('/api/entries/900', { cookie: adminCookie });
  });

  it('returns 404 for non-existent type', async () => {
    const res = await client.delete('/api/vehicle-types/99999', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

// ─── Entries CRUD ────────────────────────────────────────────────────────
describe('GET /api/entries (empty)', () => {
  it('returns empty object initially', async () => {
    const res = await client.get('/api/entries');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, {});
  });
});

describe('POST /api/entries', () => {
  it('creates entry with num, univ, team', async () => {
    const res = await client.post('/api/entries', {
      body: { num: 1, univ: 'TestUniv', team: 'TestTeam' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
  });

  it('creates entry with type (after creating vehicle type)', async () => {
    const res = await client.post('/api/entries', {
      body: { num: 2, univ: 'TypeUniv', team: 'TypeTeam', type: 'EV' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
  });

  it('rejects missing num (400)', async () => {
    const res = await client.post('/api/entries', {
      body: { univ: 'U', team: 'T' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid num (400)', async () => {
    const res = await client.post('/api/entries', {
      body: { num: -1, univ: 'U', team: 'T' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing univ (400)', async () => {
    const res = await client.post('/api/entries', {
      body: { num: 99, team: 'T' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects missing team (400)', async () => {
    const res = await client.post('/api/entries', {
      body: { num: 99, univ: 'U' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects non-existent vehicle type (400)', async () => {
    const res = await client.post('/api/entries', {
      body: { num: 99, univ: 'U', team: 'T', type: 'NonExistent' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects duplicate num (PK violation, 400)', async () => {
    const res = await client.post('/api/entries', {
      body: { num: 1, univ: 'DupUniv', team: 'DupTeam' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

describe('GET /api/entries (populated)', () => {
  it('returns created entries', async () => {
    const res = await client.get('/api/entries');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data[1]);
    assert.equal(data[1].univ, 'TestUniv');
    assert.equal(data[1].team, 'TestTeam');
    assert.ok(data[2]);
    assert.equal(data[2].type, 'EV');
  });

  it('returns with Content-Disposition header on download', async () => {
    const res = await client.get('/api/entries?download');
    assert.equal(res.status, 200);
    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition);
    assert.ok(disposition.includes('attachment'));
    assert.ok(disposition.includes('entry_'));
  });
});

describe('PATCH /api/entries/:num', () => {
  it('updates entry data', async () => {
    const res = await client.patch('/api/entries/1', {
      body: { num: 1, univ: 'UpdatedUniv', team: 'UpdatedTeam' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    // Verify update
    const getRes = await client.get('/api/entries');
    const data = await getRes.json();
    assert.equal(data[1].univ, 'UpdatedUniv');
    assert.equal(data[1].team, 'UpdatedTeam');
  });

  it('changes entry number', async () => {
    const res = await client.patch('/api/entries/1', {
      body: { num: 100, univ: 'UpdatedUniv', team: 'UpdatedTeam' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    // Verify old num is gone and new num exists
    const getRes = await client.get('/api/entries');
    const data = await getRes.json();
    assert.equal(data[1], undefined);
    assert.ok(data[100]);
    assert.equal(data[100].univ, 'UpdatedUniv');

    // Rename back for subsequent tests
    await client.patch('/api/entries/100', {
      body: { num: 1, univ: 'UpdatedUniv', team: 'UpdatedTeam' },
      cookie: adminCookie,
    });
  });

  it('returns 404 for non-existent entry', async () => {
    const res = await client.patch('/api/entries/9999', {
      body: { num: 9999, univ: 'U', team: 'T' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });

  it('rejects renumber to existing entry number (PK conflict)', async () => {
    // Create two entries first
    await client.post('/api/entries', { cookie: adminCookie, body: { num: 100, univ: 'A대', team: '팀A' } });
    await client.post('/api/entries', { cookie: adminCookie, body: { num: 101, univ: 'B대', team: '팀B' } });

    // Try to rename 101 to 100 (conflict)
    const res = await client.patch('/api/entries/101', {
      cookie: adminCookie,
      body: { num: 100, univ: 'B대', team: '팀B' },
    });
    assert.equal(res.status, 400);

    // Cleanup
    await client.delete('/api/entries/100', { cookie: adminCookie });
    await client.delete('/api/entries/101', { cookie: adminCookie });
  });
});

describe('DELETE /api/entries/:num', () => {
  it('deletes entry', async () => {
    // Create a disposable entry
    await client.post('/api/entries', {
      body: { num: 50, univ: 'DelUniv', team: 'DelTeam' },
      cookie: adminCookie,
    });

    const res = await client.delete('/api/entries/50', { cookie: adminCookie });
    assert.equal(res.status, 200);

    // Verify deletion
    const getRes = await client.get('/api/entries');
    const data = await getRes.json();
    assert.equal(data[50], undefined);
  });

  it('returns 404 for non-existent entry', async () => {
    const res = await client.delete('/api/entries/9999', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/entries (all)', () => {
  it('deletes all entries', async () => {
    // Ensure there is at least one entry
    await client.post('/api/entries', {
      body: { num: 10, univ: 'AllDelUniv', team: 'AllDelTeam' },
      cookie: adminCookie,
    });

    const res = await client.delete('/api/entries', { cookie: adminCookie });
    assert.equal(res.status, 200);

    // Verify all gone
    const getRes = await client.get('/api/entries');
    const data = await getRes.json();
    assert.deepEqual(data, {});
  });
});

// ─── Bulk Upload ─────────────────────────────────────────────────────────
describe('POST /api/entries/bulk', () => {
  it('replaces all entries', async () => {
    // Seed an entry first
    await client.post('/api/entries', {
      body: { num: 1, univ: 'OldUniv', team: 'OldTeam' },
      cookie: adminCookie,
    });

    const res = await client.post('/api/entries/bulk', {
      body: {
        data: {
          '10': { univ: 'BulkUniv1', team: 'BulkTeam1' },
          '20': { univ: 'BulkUniv2', team: 'BulkTeam2' },
        },
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    // Verify old entry replaced and new entries exist
    const getRes = await client.get('/api/entries');
    const data = await getRes.json();
    assert.equal(data[1], undefined, 'old entry should be gone');
    assert.ok(data[10]);
    assert.equal(data[10].univ, 'BulkUniv1');
    assert.ok(data[20]);
    assert.equal(data[20].univ, 'BulkUniv2');
  });

  it('validates JSON format', async () => {
    const res = await client.post('/api/entries/bulk', {
      body: { data: 'not-valid-json' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects invalid vehicle type in bulk data', async () => {
    const res = await client.post('/api/entries/bulk', {
      body: {
        data: {
          '1': { univ: 'U', team: 'T', type: 'NoSuchType' },
        },
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Year Validation ─────────────────────────────────────────────────────
describe('Year validation', () => {
  it('GET /api/entries?year=2100 returns 400 (out of range)', async () => {
    const res = await client.get('/api/entries?year=2100');
    assert.equal(res.status, 400);
  });

  it('GET /api/entries?year=1999 returns 400 (out of range)', async () => {
    const res = await client.get('/api/entries?year=1999');
    assert.equal(res.status, 400);
  });

  it('POST /api/entries?year=2025 creates entry for specific year', async () => {
    const res = await client.post('/api/entries?year=2025', {
      body: { num: 5, univ: 'Year2025Univ', team: 'Year2025Team' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);

    // Verify it exists for that year
    const getRes = await client.get('/api/entries?year=2025');
    const data = await getRes.json();
    assert.ok(data[5]);
    assert.equal(data[5].univ, 'Year2025Univ');

    // Clean up
    await client.delete('/api/entries/5?year=2025', { cookie: adminCookie });
  });
});

// ─── Auth ────────────────────────────────────────────────────────────────
describe('Auth enforcement', () => {
  it('POST /api/entries without auth returns 401', async () => {
    const res = await client.post('/api/entries', {
      body: { num: 99, univ: 'U', team: 'T' },
    });
    assert.equal(res.status, 401);
  });

  it('POST /api/vehicle-types without auth returns 401', async () => {
    const res = await client.post('/api/vehicle-types', {
      body: { name: 'NoAuth' },
    });
    assert.equal(res.status, 401);
  });

  it('GET /api/entries without auth returns 200 (public)', async () => {
    const res = await client.get('/api/entries');
    assert.equal(res.status, 200);
  });

  it('GET /api/vehicle-types without auth returns 200 (public)', async () => {
    const res = await client.get('/api/vehicle-types');
    assert.equal(res.status, 200);
  });

  it('GET /api/health without auth returns 200 (public)', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
  });

  it('GET /api/years without auth returns 200 (public)', async () => {
    const res = await client.get('/api/years');
    assert.equal(res.status, 200);
  });

  it('DELETE /api/entries/:num without auth returns 401', async () => {
    const res = await client.delete('/api/entries/1');
    assert.equal(res.status, 401);
  });

  it('PATCH /api/entries/:num without auth returns 401', async () => {
    const res = await client.patch('/api/entries/1', {
      body: { num: 1, univ: 'U', team: 'T' },
    });
    assert.equal(res.status, 401);
  });

  it('DELETE /api/entries without auth returns 401', async () => {
    const res = await client.delete('/api/entries');
    assert.equal(res.status, 401);
  });

  it('POST /api/entries/bulk without auth returns 401', async () => {
    const res = await client.post('/api/entries/bulk', {
      body: { data: {} },
    });
    assert.equal(res.status, 401);
  });

  it('DELETE /api/vehicle-types/:id without auth returns 401', async () => {
    const res = await client.delete('/api/vehicle-types/1');
    assert.equal(res.status, 401);
  });
});

// ─── Documents Sync on Number Change ────────────────────────────────────
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const expressForMock = require('../../entry/node_modules/express/index.js');

describe('PATCH /api/entries/:num — documents sync', () => {

  let mockDocServer, mockDocUrl;
  let receivedRequests;

  before(async () => {
    // Create entry for sync tests
    await client.post('/api/entries', {
      body: { num: 70, univ: 'SyncUniv', team: 'SyncTeam' },
      cookie: adminCookie,
    });
  });

  it('calls documents internal API when number changes and DOCUMENTS_SERVER is set', async () => {
    receivedRequests = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.patch('/api/internal/team-num', (req, res) => {
      receivedRequests.push(req.body);
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    mockDocServer = started.server;
    mockDocUrl = started.baseUrl;

    process.env.DOCUMENTS_SERVER = mockDocUrl;

    const res = await client.patch('/api/entries/70', {
      body: { num: 71, univ: 'SyncUniv', team: 'SyncTeam' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    // Small delay for async fetch to complete
    await new Promise(r => setTimeout(r, 100));

    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].prevNum, 70);
    assert.equal(receivedRequests[0].newNum, 71);
    assert.equal(receivedRequests[0].year, new Date().getFullYear());

    await stopServer(mockDocServer);
    delete process.env.DOCUMENTS_SERVER;
  });

  it('does not call documents when number does not change', async () => {
    receivedRequests = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.patch('/api/internal/team-num', (req, res) => {
      receivedRequests.push(req.body);
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    mockDocServer = started.server;
    mockDocUrl = started.baseUrl;

    process.env.DOCUMENTS_SERVER = mockDocUrl;

    // Update entry 71 without changing its number
    const res = await client.patch('/api/entries/71', {
      body: { num: 71, univ: 'SyncUnivUpdated', team: 'SyncTeamUpdated' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    await new Promise(r => setTimeout(r, 100));

    assert.equal(receivedRequests.length, 0, 'should not call documents when number unchanged');

    await stopServer(mockDocServer);
    delete process.env.DOCUMENTS_SERVER;
  });

  it('entry update returns 207 when documents service sync fails', async () => {
    receivedRequests = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.patch('/api/internal/team-num', (req, res) => {
      receivedRequests.push(req.body);
      res.status(500).send('Internal Server Error');
    });
    const started = await startServer(mockApp);
    mockDocServer = started.server;
    mockDocUrl = started.baseUrl;

    process.env.DOCUMENTS_SERVER = mockDocUrl;

    const res = await client.patch('/api/entries/71', {
      body: { num: 72, univ: 'SyncUnivUpdated', team: 'SyncTeamUpdated' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 207, 'entry update should return 207 when documents sync fails');

    await new Promise(r => setTimeout(r, 100));

    assert.equal(receivedRequests.length, 1, 'should have attempted the call');

    // Verify entry was actually updated
    const getRes = await client.get('/api/entries');
    const data = await getRes.json();
    assert.ok(data[72], 'entry 72 should exist');
    assert.equal(data[72].univ, 'SyncUnivUpdated');

    await stopServer(mockDocServer);
    delete process.env.DOCUMENTS_SERVER;

    // Cleanup
    await client.delete('/api/entries/72', { cookie: adminCookie });
  });
});
