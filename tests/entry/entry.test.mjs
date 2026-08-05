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

let server, baseUrl, client, db, dbPath, stopLifecycleOutboxRetry;

before(async () => {
  dbPath = tmpDbPath();
  const result = createEntryApp({ dbPath });
  db = result.db;
  stopLifecycleOutboxRetry = result.stopLifecycleOutboxRetry;
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  stopLifecycleOutboxRetry?.();
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
    assert.equal(data.color, 'blue');
  });

  it('creates a vehicle type with color', async () => {
    const res = await client.post('/api/vehicle-types', {
      body: { name: 'HEV', color: 'green' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.name, 'HEV');
    assert.equal(data.color, 'green');
  });

  it('defaults to blue for invalid color', async () => {
    const res = await client.post('/api/vehicle-types', {
      body: { name: 'FCEV', color: 'invalid' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.color, 'blue');
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
    assert.ok(data.sort_order > 0, 'sort_order should auto-increment');
  });
});

describe('PATCH /api/vehicle-types/:id', () => {
  it('updates vehicle type color', async () => {
    const listRes = await client.get('/api/vehicle-types');
    const types = await listRes.json();
    const ev = types.find(t => t.name === 'EV');

    const res = await client.patch(`/api/vehicle-types/${ev.id}`, {
      body: { color: 'red' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    const updated = await client.get('/api/vehicle-types');
    const updatedTypes = await updated.json();
    assert.equal(updatedTypes.find(t => t.id === ev.id).color, 'red');
  });

  it('rejects invalid color', async () => {
    const listRes = await client.get('/api/vehicle-types');
    const types = await listRes.json();

    const res = await client.patch(`/api/vehicle-types/${types[0].id}`, {
      body: { color: 'pink' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('returns 404 for non-existent type', async () => {
    const res = await client.patch('/api/vehicle-types/99999', {
      body: { color: 'blue' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });

  it('renames a vehicle type', async () => {
    const listRes = await client.get('/api/vehicle-types');
    const types = await listRes.json();
    const cv = types.find(t => t.name === 'CV');

    const res = await client.patch(`/api/vehicle-types/${cv.id}`, {
      body: { name: 'CV2' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    const updated = await client.get('/api/vehicle-types');
    const updatedTypes = await updated.json();
    assert.equal(updatedTypes.find(t => t.id === cv.id).name, 'CV2');

    // Restore original name
    await client.patch(`/api/vehicle-types/${cv.id}`, {
      body: { name: 'CV' },
      cookie: adminCookie,
    });
  });

  it('rename cascades to entries', async () => {
    // Create a type and an entry referencing it
    const typeRes = await client.post('/api/vehicle-types', {
      body: { name: 'RenameTest' },
      cookie: adminCookie,
    });
    const typeData = await typeRes.json();

    await client.post('/api/entries', {
      body: { num: 77, univ: 'RenameUniv', team: 'RenameTeam', type: 'RenameTest' },
      cookie: adminCookie,
    });

    // Rename the type
    await client.patch(`/api/vehicle-types/${typeData.id}`, {
      body: { name: 'Renamed' },
      cookie: adminCookie,
    });

    // Verify entry type was updated
    const entries = await (await client.get('/api/entries')).json();
    assert.equal(entries['77'].type, 'Renamed');

    // Cleanup
    await client.delete('/api/entries/77', { cookie: adminCookie });
    await client.delete(`/api/vehicle-types/${typeData.id}`, { cookie: adminCookie });
  });

  it('rejects duplicate name on rename', async () => {
    const listRes = await client.get('/api/vehicle-types');
    const types = await listRes.json();
    const ev = types.find(t => t.name === 'EV');

    const res = await client.patch(`/api/vehicle-types/${ev.id}`, {
      body: { name: 'CV' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('rejects empty name on rename', async () => {
    const listRes = await client.get('/api/vehicle-types');
    const types = await listRes.json();

    const res = await client.patch(`/api/vehicle-types/${types[0].id}`, {
      body: { name: '  ' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
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
    // 같은 번호에서 학교/팀명을 바꾸는 것은 명칭 정정(retain)으로 명시해야 한다.
    const res = await client.patch('/api/entries/1', {
      body: { num: 1, univ: 'UpdatedUniv', team: 'UpdatedTeam', intent: 'retain' },
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

  it('PATCH /api/vehicle-types/:id without auth returns 401', async () => {
    const res = await client.patch('/api/vehicle-types/1', {
      body: { color: 'blue' },
    });
    assert.equal(res.status, 401);
  });

  it('DELETE /api/vehicle-types/:id without auth returns 401', async () => {
    const res = await client.delete('/api/vehicle-types/1');
    assert.equal(res.status, 401);
  });
});

// ─── SSE ───────────────────────────────────────────────────────────────────────────
describe('GET /api/events', () => {
  it('requires admin authentication', async () => {
    const res = await client.get('/api/events');
    assert.equal(res.status, 401);
  });

  it('broadcasts entry snapshot invalidation after a vehicle-type mutation', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, {
      headers: { Cookie: adminCookie, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    try {
      const init = await reader.read();
      assert.match(decoder.decode(init.value), /event: init/);

      const create = await client.post('/api/vehicle-types', {
        body: { name: `SSE-${Date.now()}` },
        cookie: adminCookie,
      });
      assert.equal(create.status, 201);

      const event = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('entry SSE timeout')), 2000)),
      ]);
      const payload = decoder.decode(event.value);
      assert.match(payload, /event: entries/);
      assert.match(payload, /"change":"vehicle-type"/);
      assert.match(payload, new RegExp(`"year":${new Date().getFullYear()}`));
    } finally {
      controller.abort();
    }
  });
});

// ─── Lifecycle Sync on Number Change ────────────────────────────────────
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const expressForMock = require('../../entry/node_modules/express/index.js');

const LIFECYCLE_SERVER_ENVS = ["QUEUE_SERVER", "DOCUMENTS_SERVER", "INSPECTION_SERVER", "SCORE_SERVER", "TRAFFIC_SERVER"];

describe('PATCH /api/entries/:num — lifecycle sync', () => {

  let mockDocServer, mockDocUrl;
  let receivedRequests;

  before(async () => {
    // Create entry for sync tests
    await client.post('/api/entries', {
      body: { num: 70, univ: 'SyncUniv', team: 'SyncTeam' },
      cookie: adminCookie,
    });
  });

  it('calls configured lifecycle internal APIs when number changes', async () => {
    receivedRequests = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.patch('/api/internal/team-num', (req, res) => {
      receivedRequests.push({ body: req.body, service: req.headers['x-internal-service'] });
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    mockDocServer = started.server;
    mockDocUrl = started.baseUrl;

    for (const key of LIFECYCLE_SERVER_ENVS) process.env[key] = mockDocUrl;

    const res = await client.patch('/api/entries/70', {
      body: { num: 71, univ: 'SyncUniv', team: 'SyncTeam' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    // Small delay for async fetch to complete
    await new Promise(r => setTimeout(r, 100));

    assert.equal(receivedRequests.length, LIFECYCLE_SERVER_ENVS.length);
    assert.ok(receivedRequests.every(r => r.body.prevNum === 70));
    assert.ok(receivedRequests.every(r => r.body.newNum === 71));
    assert.ok(receivedRequests.every(r => r.body.year === new Date().getFullYear()));
    assert.ok(receivedRequests.every(r => r.body.entry.univ === 'SyncUniv'));

    await stopServer(mockDocServer);
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
  });

  it('does not call lifecycle services when number does not change', async () => {
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

    for (const key of LIFECYCLE_SERVER_ENVS) process.env[key] = mockDocUrl;

    // Update entry 71 without changing its number — same-number identity change is a
    // name correction (retain), which must not dispatch any lifecycle (renumber) events.
    const res = await client.patch('/api/entries/71', {
      body: { num: 71, univ: 'SyncUnivUpdated', team: 'SyncTeamUpdated', intent: 'retain' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    await new Promise(r => setTimeout(r, 100));

    assert.equal(receivedRequests.length, 0, 'should not call lifecycle services when number unchanged');

    await stopServer(mockDocServer);
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
  });

  it('entry update succeeds and leaves outbox rows when lifecycle sync fails', async () => {
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
    assert.equal(res.status, 202, 'entry update should expose pending lifecycle sync without rolling back');

    await new Promise(r => setTimeout(r, 100));

    assert.equal(receivedRequests.length, 1, 'should have attempted the call');

    const getRes = await client.get('/api/entries');
    const data = await getRes.json();
    assert.ok(data[72], 'entry 72 should exist after successful local update');
    assert.ok(!data[71], 'entry 71 should no longer exist');

    const pending = db.prepare("SELECT service, attempts, last_error FROM lifecycle_outbox WHERE event_type = 'team.renumber'").all();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].service, 'documents');
    assert.equal(pending[0].attempts, 1);
    assert.match(pending[0].last_error, /status 500/);

    await stopServer(mockDocServer);
    delete process.env.DOCUMENTS_SERVER;
  });

  it('blocks number reuse while an older lifecycle event for that number is pending', async () => {
    db.prepare("DELETE FROM lifecycle_outbox").run();
    await client.post('/api/entries/bulk', {
      body: {
        data: {
          170: { univ: 'OrderUnivA', team: 'OrderTeamA' },
          171: { univ: 'OrderUnivB', team: 'OrderTeamB' },
        },
      },
      cookie: adminCookie,
    });

    const calls = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.delete('/api/internal/team/:num', (req, res) => {
      calls.push({ method: 'DELETE', num: Number(req.params.num) });
      res.status(500).send('still down');
    });
    mockApp.patch('/api/internal/team-num', (req, res) => {
      calls.push({ method: 'PATCH', body: req.body });
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    mockDocServer = started.server;
    mockDocUrl = started.baseUrl;
    process.env.DOCUMENTS_SERVER = mockDocUrl;

    const del = await client.delete('/api/entries/171', { cookie: adminCookie });
    assert.equal(del.status, 202);
    const patch = await client.patch('/api/entries/170', {
      body: { num: 171, univ: 'OrderUnivA', team: 'OrderTeamA' },
      cookie: adminCookie,
    });
    assert.equal(patch.status, 409);

    await new Promise(r => setTimeout(r, 150));
    assert.ok(calls.some(c => c.method === 'DELETE' && c.num === 171), 'older delete should be attempted');
    assert.equal(calls.some(c => c.method === 'PATCH'), false, 'renumber must not be enqueued while the reused number has pending lifecycle work');

    const pendingRenumber = db.prepare("SELECT COUNT(*) AS c FROM lifecycle_outbox WHERE event_type = 'team.renumber' AND service = 'documents'").get().c;
    assert.equal(pendingRenumber, 0, 'blocked renumber should not create another outbox row');

    await stopServer(mockDocServer);
    delete process.env.DOCUMENTS_SERVER;
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });

  it('treats downstream 202 as pending and retries it before later same-service events', async () => {
    db.prepare("DELETE FROM lifecycle_outbox").run();
    await client.post('/api/entries/bulk', {
      body: {
        data: {
          172: { univ: 'PendingUnivA', team: 'PendingTeamA' },
          173: { univ: 'PendingUnivB', team: 'PendingTeamB' },
        },
      },
      cookie: adminCookie,
    });

    const calls = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.patch('/api/internal/team-num', (req, res) => {
      calls.push(req.body);
      if (req.body.prevNum === 172 && calls.filter(c => c.prevNum === 172).length === 1) {
        return res.status(202).json({ status: 'pending_file_work' });
      }
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    mockDocServer = started.server;
    mockDocUrl = started.baseUrl;
    process.env.DOCUMENTS_SERVER = mockDocUrl;

    const first = await client.patch('/api/entries/172', {
      body: { num: 175, univ: 'PendingUnivA', team: 'PendingTeamA' },
      cookie: adminCookie,
    });
    assert.equal(first.status, 202);
    let pending = db.prepare("SELECT attempts, last_error FROM lifecycle_outbox WHERE event_type = 'team.renumber' AND service = 'documents'").all();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].attempts, 1);
    assert.match(pending[0].last_error, /status 202/);

    const second = await client.patch('/api/entries/173', {
      body: { num: 174, univ: 'PendingUnivB', team: 'PendingTeamB' },
      cookie: adminCookie,
    });
    assert.equal(second.status, 200);
    await new Promise(r => setTimeout(r, 150));

    assert.deepEqual(calls.map(c => [c.prevNum, c.newNum]), [[172, 175], [172, 175], [173, 174]]);
    pending = db.prepare("SELECT COUNT(*) AS c FROM lifecycle_outbox WHERE service = 'documents'").get().c;
    assert.equal(pending, 0);

    await stopServer(mockDocServer);
    delete process.env.DOCUMENTS_SERVER;
  });
});

// ─── Entry Delete Notifications ──────────────────────────────────────────
describe('Entry delete → service notifications', () => {
  let mockServer, mockUrl;
  let deletedNums;

  before(async () => {
    deletedNums = [];
    const mockApp = expressForMock();
    mockApp.delete('/api/internal/team/:num', (req, res) => {
      deletedNums.push({ num: Number(req.params.num), year: Number(req.query.year) });
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    mockServer = started.server;
    mockUrl = started.baseUrl;

    for (const key of LIFECYCLE_SERVER_ENVS) process.env[key] = mockUrl;

    // Create entries for delete tests
    await client.post('/api/entries', { body: { num: 80, univ: 'DelUniv', team: 'DelTeam' }, cookie: adminCookie });
    await client.post('/api/entries', { body: { num: 81, univ: 'DelUniv2', team: 'DelTeam2' }, cookie: adminCookie });
    await client.post('/api/entries', { body: { num: 82, univ: 'DelUniv3', team: 'DelTeam3' }, cookie: adminCookie });
  });

  after(async () => {
    await stopServer(mockServer);
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
  });

  it('DELETE /api/entries/:num notifies configured lifecycle services', async () => {
    deletedNums = [];
    const res = await client.delete('/api/entries/80', { cookie: adminCookie });
    assert.equal(res.status, 200);

    await new Promise(r => setTimeout(r, 200));

    const calls = deletedNums.filter(d => d.num === 80);
    assert.equal(calls.length, LIFECYCLE_SERVER_ENVS.length, 'should notify all configured lifecycle services');
  });

  it('POST /api/entries/bulk notifies for removed entries', async () => {
    deletedNums = [];
    // Bulk upload replaces all entries — 81 and 82 will be removed, 90 is new
    const res = await client.post('/api/entries/bulk', {
      body: { data: { 90: { univ: 'NewUniv', team: 'NewTeam' } } },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    await new Promise(r => setTimeout(r, 200));

    const removedNumSet = new Set(deletedNums.map(d => d.num));
    assert.ok(removedNumSet.has(81), 'should notify deletion of entry 81');
    assert.ok(removedNumSet.has(82), 'should notify deletion of entry 82');
    assert.ok(!removedNumSet.has(90), 'should not notify for new entry 90');
  });

  it('POST /api/entries/bulk emits renumber events for moved teams', async () => {
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
    await client.post('/api/entries/bulk', {
      body: {
        data: {
          300: { univ: 'BulkMoveUnivA', team: 'BulkMoveTeamA' },
          301: { univ: 'BulkMoveUnivB', team: 'BulkMoveTeamB' },
        },
      },
      cookie: adminCookie,
    });

    const renumbers = [];
    const deletes = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.patch('/api/internal/team-num', (req, res) => {
      renumbers.push(req.body);
      res.status(200).send();
    });
    mockApp.delete('/api/internal/team/:num', (req, res) => {
      deletes.push(Number(req.params.num));
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    process.env.DOCUMENTS_SERVER = started.baseUrl;

    const res = await client.post('/api/entries/bulk', {
      body: {
        data: {
          301: { univ: 'BulkMoveUnivB', team: 'BulkMoveTeamB' },
          302: { univ: 'BulkMoveUnivA', team: 'BulkMoveTeamA' },
        },
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 150));

    assert.deepEqual(renumbers.map(r => [r.prevNum, r.newNum]), [[300, 302]]);
    assert.equal(renumbers[0].entry.univ, 'BulkMoveUnivA');
    assert.equal(deletes.includes(300), false, 'moved team should not be treated as a delete');

    await stopServer(started.server);
    delete process.env.DOCUMENTS_SERVER;
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });

  it('POST /api/entries/bulk deletes a displaced target team before renumbering into its number', async () => {
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
    await client.post('/api/entries/bulk', {
      body: {
        data: {
          320: { univ: 'BulkDisplaceUnivA', team: 'BulkDisplaceTeamA' },
          321: { univ: 'BulkDisplaceUnivB', team: 'BulkDisplaceTeamB' },
        },
      },
      cookie: adminCookie,
    });

    const calls = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.delete('/api/internal/team/:num', (req, res) => {
      calls.push({ method: 'DELETE', num: Number(req.params.num) });
      res.status(200).send();
    });
    mockApp.patch('/api/internal/team-num', (req, res) => {
      calls.push({ method: 'PATCH', prevNum: req.body.prevNum, newNum: req.body.newNum });
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    process.env.DOCUMENTS_SERVER = started.baseUrl;

    const res = await client.post('/api/entries/bulk', {
      body: {
        data: {
          321: { univ: 'BulkDisplaceUnivA', team: 'BulkDisplaceTeamA' },
        },
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 150));

    assert.deepEqual(calls, [
      { method: 'DELETE', num: 321 },
      { method: 'PATCH', prevNum: 320, newNum: 321 },
    ]);

    await stopServer(started.server);
    delete process.env.DOCUMENTS_SERVER;
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });

  it('POST /api/entries/bulk accepts explicit renumber mapping when display names also change', async () => {
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
    await client.post('/api/entries/bulk', {
      body: { data: { 330: { univ: 'BulkMapUnivOld', team: 'BulkMapTeamOld' } } },
      cookie: adminCookie,
    });

    const calls = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.delete('/api/internal/team/:num', (req, res) => {
      calls.push({ method: 'DELETE', num: Number(req.params.num) });
      res.status(200).send();
    });
    mockApp.patch('/api/internal/team-num', (req, res) => {
      calls.push({ method: 'PATCH', body: req.body });
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    process.env.DOCUMENTS_SERVER = started.baseUrl;

    const res = await client.post('/api/entries/bulk', {
      body: {
        renumbers: { 330: 331 },
        data: { 331: { univ: 'BulkMapUnivNew', team: 'BulkMapTeamNew' } },
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 150));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(calls[0].body.prevNum, 330);
    assert.equal(calls[0].body.newNum, 331);
    assert.equal(calls[0].body.entry.univ, 'BulkMapUnivNew');

    await stopServer(started.server);
    delete process.env.DOCUMENTS_SERVER;
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });

  it('POST /api/entries/bulk rejects a self-map renumber so it cannot bypass the same-number ambiguity guard', async () => {
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
    await client.post('/api/entries/bulk', {
      body: { data: { 340: { univ: 'SelfMapUnivA', team: 'SelfMapTeamA' } } },
      cookie: adminCookie,
    });

    const calls = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.delete('/api/internal/team/:num', (req, res) => { calls.push({ method: 'DELETE', num: Number(req.params.num) }); res.status(200).send(); });
    mockApp.patch('/api/internal/team-num', (req, res) => { calls.push({ method: 'PATCH', body: req.body }); res.status(200).send(); });
    const started = await startServer(mockApp);
    process.env.DOCUMENTS_SERVER = started.baseUrl;

    // self-map(340→340)을 explicit renumber로 실으면 ambiguous 검사를 우회해
    // downstream 데이터가 새 팀에 조용히 승계될 수 있었다. 이제 400으로 거부되어야 한다.
    const res = await client.post('/api/entries/bulk', {
      body: { renumbers: { 340: 340 }, data: { 340: { univ: 'SelfMapUnivB', team: 'SelfMapTeamB' } } },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400, 'self-map renumber must be rejected');
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(calls, [], 'no lifecycle events are dispatched for a rejected self-map');

    const after = await (await client.get('/api/entries', { cookie: adminCookie })).json();
    assert.equal(after['340'].team, 'SelfMapTeamA', 'entry table is unchanged on a rejected self-map');

    await stopServer(started.server);
    delete process.env.DOCUMENTS_SERVER;
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });

  it('POST /api/entries/bulk treats a same-number change declared as a name correction (retains) as a retained entry', async () => {
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
    await client.post('/api/entries/bulk', {
      body: { data: { 305: { univ: 'BulkCorrectUniv', team: 'BulkCorrectTeam' } } },
      cookie: adminCookie,
    });

    const calls = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.patch('/api/internal/team-num', (req, res) => {
      calls.push({ method: 'PATCH', body: req.body });
      res.status(200).send();
    });
    mockApp.delete('/api/internal/team/:num', (req, res) => {
      calls.push({ method: 'DELETE', num: Number(req.params.num) });
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    process.env.DOCUMENTS_SERVER = started.baseUrl;

    const res = await client.post('/api/entries/bulk', {
      body: { data: { 305: { univ: 'BulkCorrectUnivFixed', team: 'BulkCorrectTeamFixed' } }, retains: [305] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(calls, [], 'a same number explicitly declared a name correction should not trigger lifecycle delete/renumber');

    await stopServer(started.server);
    delete process.env.DOCUMENTS_SERVER;
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });

  it('POST /api/entries/bulk rejects an undeclared same-number team change with 409', async () => {
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
    await client.post('/api/entries/bulk', {
      body: { data: { 306: { univ: 'BulkAmbigUnivA', team: 'BulkAmbigTeamA' } } },
      cookie: adminCookie,
    });

    const calls = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.patch('/api/internal/team-num', (req, res) => {
      calls.push({ method: 'PATCH', body: req.body });
      res.status(200).send();
    });
    mockApp.delete('/api/internal/team/:num', (req, res) => {
      calls.push({ method: 'DELETE', num: Number(req.params.num) });
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    process.env.DOCUMENTS_SERVER = started.baseUrl;

    const res = await client.post('/api/entries/bulk', {
      body: { data: { 306: { univ: 'BulkAmbigUnivB', team: 'BulkAmbigTeamB' } } },
      cookie: adminCookie,
    });
    assert.equal(res.status, 409);
    const payload = await res.json();
    assert.ok(Array.isArray(payload.ambiguous), 'response carries the ambiguous list');
    const entry = payload.ambiguous.find(a => a.num === 306);
    assert.ok(entry, '306 reported as ambiguous');
    assert.equal(entry.from.team, 'BulkAmbigTeamA');
    assert.equal(entry.to.team, 'BulkAmbigTeamB');

    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(calls, [], 'no lifecycle events are dispatched while the change is unresolved');

    // The upload was rolled back: 306 still holds the original team.
    const after = await (await client.get('/api/entries', { cookie: adminCookie })).json();
    assert.equal(after['306'].team, 'BulkAmbigTeamA', 'entry table is unchanged on a 409');

    await stopServer(started.server);
    delete process.env.DOCUMENTS_SERVER;
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });

  it('POST /api/entries/bulk deletes downstream data when a same-number change is declared a replacement', async () => {
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
    await client.post('/api/entries/bulk', {
      body: { data: { 307: { univ: 'BulkReplaceUnivA', team: 'BulkReplaceTeamA' } } },
      cookie: adminCookie,
    });

    const calls = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.patch('/api/internal/team-num', (req, res) => {
      calls.push({ method: 'PATCH', body: req.body });
      res.status(200).send();
    });
    mockApp.delete('/api/internal/team/:num', (req, res) => {
      calls.push({ method: 'DELETE', num: Number(req.params.num) });
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    process.env.DOCUMENTS_SERVER = started.baseUrl;

    const res = await client.post('/api/entries/bulk', {
      body: { data: { 307: { univ: 'BulkReplaceUnivB', team: 'BulkReplaceTeamB' } }, replacements: [307] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(calls, [{ method: 'DELETE', num: 307 }], 'a declared replacement drops the old team\'s downstream data');

    const after = await (await client.get('/api/entries', { cookie: adminCookie })).json();
    assert.equal(after['307'].team, 'BulkReplaceTeamB', 'entry table holds the new team');

    await stopServer(started.server);
    delete process.env.DOCUMENTS_SERVER;
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });

  it('POST /api/entries/bulk uses a temporary renumber for number swaps', async () => {
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
    await client.post('/api/entries/bulk', {
      body: {
        data: {
          310: { univ: 'BulkSwapUnivA', team: 'BulkSwapTeamA' },
          311: { univ: 'BulkSwapUnivB', team: 'BulkSwapTeamB' },
        },
      },
      cookie: adminCookie,
    });

    const renumbers = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.patch('/api/internal/team-num', (req, res) => {
      renumbers.push(req.body);
      res.status(200).send();
    });
    mockApp.delete('/api/internal/team/:num', (_req, res) => res.status(200).send());
    const started = await startServer(mockApp);
    process.env.DOCUMENTS_SERVER = started.baseUrl;

    const res = await client.post('/api/entries/bulk', {
      body: {
        data: {
          310: { univ: 'BulkSwapUnivB', team: 'BulkSwapTeamB' },
          311: { univ: 'BulkSwapUnivA', team: 'BulkSwapTeamA' },
        },
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 150));

    assert.equal(renumbers.length, 3);
    const temp = renumbers[0].newNum;
    assert.ok(temp >= 1_000_000_000, 'first step should park one team in a temporary number');
    assert.deepEqual(renumbers.map(r => [r.prevNum, r.newNum]), [[310, temp], [311, 310], [temp, 311]]);

    await stopServer(started.server);
    delete process.env.DOCUMENTS_SERVER;
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });
});

// ─── Single-PATCH same-number identity intent ────────────────────────────
describe('PATCH /api/entries/:num — same-number identity intent', () => {
  before(async () => {
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
    await client.post('/api/entries', { body: { num: 600, univ: 'IdUnivA', team: 'IdTeamA' }, cookie: adminCookie });
  });

  after(() => {
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });

  it('returns 409 ambiguous when team identity changes on the same number without intent', async () => {
    const res = await client.patch('/api/entries/600', {
      body: { num: 600, univ: 'IdUnivB', team: 'IdTeamB' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 409);
    const payload = await res.json();
    assert.ok(Array.isArray(payload.ambiguous), 'response carries the ambiguous list');
    assert.equal(payload.ambiguous[0].num, 600);
    assert.equal(payload.ambiguous[0].from.team, 'IdTeamA');
    assert.equal(payload.ambiguous[0].to.team, 'IdTeamB');

    const data = await (await client.get('/api/entries')).json();
    assert.equal(data['600'].team, 'IdTeamA', 'entry must not change on an unresolved ambiguous edit');
  });

  it('an identical-identity edit is a no-op update, never ambiguous', async () => {
    const res = await client.patch('/api/entries/600', {
      body: { num: 600, univ: 'IdUnivA', team: 'IdTeamA' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200, 'unchanged identity must not be reported ambiguous');
  });

  it('retain intent updates identity without dispatching lifecycle events', async () => {
    const calls = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.delete('/api/internal/team/:num', (req, res) => { calls.push({ method: 'DELETE', num: Number(req.params.num) }); res.status(200).send(); });
    mockApp.patch('/api/internal/team-num', (req, res) => { calls.push({ method: 'PATCH', body: req.body }); res.status(200).send(); });
    const started = await startServer(mockApp);
    for (const key of LIFECYCLE_SERVER_ENVS) process.env[key] = started.baseUrl;

    const res = await client.patch('/api/entries/600', {
      body: { num: 600, univ: 'IdUnivB', team: 'IdTeamB', intent: 'retain' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(calls, [], 'retain (name correction) keeps downstream data, no events dispatched');

    const data = await (await client.get('/api/entries')).json();
    assert.equal(data['600'].team, 'IdTeamB', 'entry identity is updated');

    await stopServer(started.server);
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });

  it('replacement intent updates identity and emits a delete event to drop downstream data', async () => {
    const calls = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.delete('/api/internal/team/:num', (req, res) => { calls.push({ method: 'DELETE', num: Number(req.params.num) }); res.status(200).send(); });
    mockApp.patch('/api/internal/team-num', (req, res) => { calls.push({ method: 'PATCH', body: req.body }); res.status(200).send(); });
    const started = await startServer(mockApp);
    process.env.DOCUMENTS_SERVER = started.baseUrl;

    const res = await client.patch('/api/entries/600', {
      body: { num: 600, univ: 'IdUnivC', team: 'IdTeamC', intent: 'replacement' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(calls, [{ method: 'DELETE', num: 600 }], 'replacement drops the old team\'s downstream data via a delete event');

    const data = await (await client.get('/api/entries')).json();
    assert.equal(data['600'].team, 'IdTeamC', 'entry table holds the new team');

    await stopServer(started.server);
    delete process.env.DOCUMENTS_SERVER;
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });
});

// ─── Lifecycle outbox: dead-letter + admin recovery ──────────────────────
describe('lifecycle outbox — dead-letter + admin recovery', () => {
  let failServer;

  before(async () => {
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.delete('/api/internal/team/:num', (req, res) => res.status(500).send('down'));
    mockApp.patch('/api/internal/team-num', (req, res) => res.status(500).send('down'));
    const started = await startServer(mockApp);
    failServer = started.server;
    process.env.DOCUMENTS_SERVER = started.baseUrl;
  });

  after(async () => {
    await stopServer(failServer);
    delete process.env.DOCUMENTS_SERVER;
    db.prepare("DELETE FROM lifecycle_outbox").run();
  });

  it('transitions a permanently-failing row to dead and stops blocking the referenced number', async () => {
    await client.post('/api/entries', { body: { num: 900, univ: 'DeadUniv', team: 'DeadTeam' }, cookie: adminCookie });
    const del = await client.delete('/api/entries/900', { cookie: adminCookie });
    assert.equal(del.status, 202, 'delete exposes pending sync without rolling back');

    const rowA = db.prepare("SELECT id FROM lifecycle_outbox WHERE service='documents' AND path LIKE '%/team/900%'").get();
    assert.ok(rowA, 'a delete event was enqueued for #900');

    // While pending and still blocking, #900 cannot be re-created.
    const blocked = await client.post('/api/entries', { body: { num: 900, univ: 'X', team: 'Y' }, cookie: adminCookie });
    assert.equal(blocked.status, 409, 'pending lifecycle ref blocks reuse of #900');

    // Simulate near-exhausted attempts, then trigger one more drain via a second failing op.
    db.prepare("UPDATE lifecycle_outbox SET attempts = 23, status = 'pending', next_attempt_at = 0, locked_until = 0, locked_by = '' WHERE id = ?").run(rowA.id);
    await client.post('/api/entries', { body: { num: 901, univ: 'DeadUniv2', team: 'DeadTeam2' }, cookie: adminCookie });
    await client.delete('/api/entries/901', { cookie: adminCookie });
    await new Promise(r => setTimeout(r, 150));

    const deadRow = db.prepare("SELECT status, attempts FROM lifecycle_outbox WHERE id = ?").get(rowA.id);
    assert.equal(deadRow.status, 'dead', 'row goes dead after exceeding LIFECYCLE_MAX_ATTEMPTS');
    assert.ok(deadRow.attempts >= 24, 'attempts reflect the terminal failure');

    // A dead row must no longer 409-block operations on its number.
    const recreate = await client.post('/api/entries', { body: { num: 900, univ: 'NewTeamUniv', team: 'NewTeam' }, cookie: adminCookie });
    assert.equal(recreate.status, 201, 'a dead lifecycle row must not permanently block the referenced number');
  });

  it('admin can list, retry, and discard outbox rows', async () => {
    // Isolate from rows left by the previous test: a documents row drains oldest-first,
    // so a stale older pending row would block the synthetic row under test.
    db.prepare("DELETE FROM lifecycle_outbox").run();
    const year = new Date().getFullYear();
    const insert = db.prepare("INSERT INTO lifecycle_outbox (event_type, service, method, path, body, attempts, status, next_attempt_at) VALUES ('team.delete','documents','DELETE',?,NULL,24,'dead',0)")
      .run(`/api/internal/team/950?year=${year}`);
    const id = Number(insert.lastInsertRowid);

    const list = await client.get('/api/admin/lifecycle-outbox?status=dead', { cookie: adminCookie });
    assert.equal(list.status, 200);
    const rows = await list.json();
    assert.ok(rows.some(r => r.id === id && r.status === 'dead'), 'dead row is listed');

    const retry = await client.post(`/api/admin/lifecycle-outbox/${id}/retry`, { cookie: adminCookie });
    assert.equal(retry.status, 200);
    const afterRetry = db.prepare("SELECT status, attempts FROM lifecycle_outbox WHERE id = ?").get(id);
    assert.notEqual(afterRetry.status, 'dead', 'retry resets a dead row back to pending');
    assert.equal(afterRetry.attempts, 1, 'retry zeroes attempts then re-dispatches once (which fails)');

    const discard = await client.delete(`/api/admin/lifecycle-outbox/${id}`, { cookie: adminCookie });
    assert.equal(discard.status, 200);
    assert.equal(db.prepare("SELECT 1 FROM lifecycle_outbox WHERE id = ?").get(id), undefined, 'discard removes the row');

    const missing = await client.delete(`/api/admin/lifecycle-outbox/${id}`, { cookie: adminCookie });
    assert.equal(missing.status, 404, 'discarding a missing row is 404');
  });
});

describe('Entry active state', () => {
  let statusServer;

  before(async () => {
    for (const key of LIFECYCLE_SERVER_ENVS) delete process.env[key];
    db.prepare("DELETE FROM lifecycle_outbox").run();
    const calls = [];
    const mockApp = expressForMock();
    mockApp.use(expressForMock.json());
    mockApp.patch('/api/internal/team-active', (req, res) => {
      calls.push(req.body);
      res.status(200).send();
    });
    const started = await startServer(mockApp);
    statusServer = { ...started, calls };
    process.env.DOCUMENTS_SERVER = started.baseUrl;
    await client.post('/api/entries', {
      body: { num: 990, univ: 'Inactive Univ', team: 'Inactive Team' },
      cookie: adminCookie,
    });
  });

  after(async () => {
    delete process.env.DOCUMENTS_SERVER;
    db.prepare("DELETE FROM lifecycle_outbox").run();
    await stopServer(statusServer.server);
  });

  it('hides inactive entries by default and exposes them only to an admin query', async () => {
    const deactivate = await client.patch('/api/entries/990/active', {
      body: { active: false },
      cookie: adminCookie,
    });
    assert.equal(deactivate.status, 200);
    assert.equal(statusServer.calls.length, 1);
    assert.equal(statusServer.calls[0].num, 990);
    assert.equal(statusServer.calls[0].active, false);
    assert.ok(Number.isInteger(statusServer.calls[0].revision));

    const publicEntries = await (await client.get('/api/entries')).json();
    assert.equal(publicEntries['990'], undefined);

    const unauthorized = await client.get('/api/entries?includeInactive=true');
    assert.equal(unauthorized.status, 401);

    const allEntries = await (await client.get('/api/entries?includeInactive=true', { cookie: adminCookie })).json();
    assert.equal(allEntries['990'].active, false);

    const activate = await client.patch('/api/entries/990/active', {
      body: { active: true },
      cookie: adminCookie,
    });
    assert.equal(activate.status, 200);
    assert.equal(statusServer.calls.at(-1).active, true);
    assert.ok(statusServer.calls.at(-1).revision > statusServer.calls[0].revision);
    const restored = await (await client.get('/api/entries')).json();
    assert.equal(restored['990'].active, true);
  });
});
