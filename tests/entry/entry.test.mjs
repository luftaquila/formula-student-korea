import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  tmpDbPath,
  makeAuthCookie,
  createClient,
  startServer,
  stopServer,
  cleanup,
  setupTestEnv,
  TRUST_JWT,
} from '../helpers/test-utils.mjs';

setupTestEnv();

import { createEntryApp } from '../../entry/index.mjs';

const requireFromEntry = createRequire(new URL('../../entry/package.json', import.meta.url));
const Database = requireFromEntry('better-sqlite3');

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });

// 다운스트림 동기화는 pull 기반(team-state)이라 entry는 변이 시 어떤 서비스에도 요청을
// 보내지 않는다 — mock 서버·sink 없이 앱과 DB만 있으면 된다. 스냅샷·tombstone·id 의미론은
// team-state.test.mjs가 다룬다.
let server, baseUrl, client, db, dbPath;

before(async () => {
  dbPath = tmpDbPath();
  const result = createEntryApp({ dbPath, validateUser: TRUST_JWT });
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

describe('Entry annual-table migration', () => {
  it('adds active-state columns before creating indexes on a legacy table', () => {
    const legacyPath = tmpDbPath();
    const year = new Date().getFullYear();
    const legacyDb = new Database(legacyPath);
    legacyDb.exec(`
      CREATE TABLE entry_${year} (
        num INTEGER PRIMARY KEY,
        univ TEXT NOT NULL,
        team TEXT NOT NULL,
        type TEXT DEFAULT NULL
      );
      INSERT INTO entry_${year} (num, univ, team, type)
      VALUES (1, 'Legacy University', 'Legacy Team', NULL);
    `);
    legacyDb.close();

    let migratedDb;
    try {
      const result = createEntryApp({ dbPath: legacyPath, validateUser: TRUST_JWT });
      migratedDb = result.db;

      const columns = migratedDb.prepare(`PRAGMA table_info('entry_${year}')`).all().map((column) => column.name);
      assert.ok(columns.includes('active'));
      assert.ok(columns.includes('active_revision'));
      assert.equal(migratedDb.prepare(`SELECT active FROM entry_${year} WHERE num = 1`).get().active, 1);

      const indexes = migratedDb.prepare(`PRAGMA index_list('entry_${year}')`).all().map((index) => index.name);
      assert.ok(indexes.includes(`idx_entry_${year}_active`));
    } finally {
      migratedDb?.close();
      cleanup(legacyPath);
    }
  });
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
  it('returns created entries with their immutable id', async () => {
    const res = await client.get('/api/entries');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data[1]);
    assert.equal(data[1].univ, 'TestUniv');
    assert.equal(data[1].team, 'TestTeam');
    assert.ok(Number.isInteger(data[1].id) && data[1].id >= 1, 'each row carries its immutable id');
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

  it('changes entry number and keeps the row id', async () => {
    const before = await (await client.get('/api/entries')).json();

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
    assert.equal(data[100].id, before[1].id, 'renumber must not change the immutable id');

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

// ─── Entry number upper bound ────────────────────────────────────────────
describe('entry number upper bound (1,000,000,000)', () => {
  const year = 2051;

  it('POST rejects num >= 1,000,000,000', async () => {
    const res = await client.post(`/api/entries?year=${year}`, {
      body: { num: 1_000_000_000, univ: 'U', team: 'T' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PATCH rejects a renumber to num >= 1,000,000,000', async () => {
    const create = await client.post(`/api/entries?year=${year}`, {
      body: { num: 1, univ: 'LimitUniv', team: 'LimitTeam' },
      cookie: adminCookie,
    });
    assert.equal(create.status, 201);

    const res = await client.patch(`/api/entries/1?year=${year}`, {
      body: { num: 1_000_000_000, univ: 'LimitUniv', team: 'LimitTeam' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('bulk rejects keys and renumber targets >= 1,000,000,000', async () => {
    const badKey = await client.post(`/api/entries/bulk?year=${year}`, {
      body: { data: { '1000000000': { univ: 'U', team: 'T' } } },
      cookie: adminCookie,
    });
    assert.equal(badKey.status, 400);

    const badRenumber = await client.post(`/api/entries/bulk?year=${year}`, {
      body: { renumbers: { 1: 1_000_000_000 }, data: { 1: { univ: 'LimitUniv', team: 'LimitTeam' } } },
      cookie: adminCookie,
    });
    assert.equal(badRenumber.status, 400);
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

// ─── Single-PATCH same-number identity intent ────────────────────────────
// id 승계·tombstone 의미론(retain은 id 유지, replacement는 새 id + tombstone)은
// team-state.test.mjs가 검증한다. 여기서는 라우트 수준의 intent 흐름만 본다.
describe('PATCH /api/entries/:num — same-number identity intent', () => {
  const year = 2053;

  before(async () => {
    const res = await client.post(`/api/entries?year=${year}`, {
      body: { num: 600, univ: 'IdUnivA', team: 'IdTeamA' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
  });

  it('returns 409 ambiguous when team identity changes on the same number without intent', async () => {
    const res = await client.patch(`/api/entries/600?year=${year}`, {
      body: { num: 600, univ: 'IdUnivB', team: 'IdTeamB' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 409);
    const payload = await res.json();
    assert.ok(Array.isArray(payload.ambiguous), 'response carries the ambiguous list');
    assert.equal(payload.ambiguous[0].num, 600);
    assert.equal(payload.ambiguous[0].from.team, 'IdTeamA');
    assert.equal(payload.ambiguous[0].to.team, 'IdTeamB');

    const data = await (await client.get(`/api/entries?year=${year}`)).json();
    assert.equal(data['600'].team, 'IdTeamA', 'entry must not change on an unresolved ambiguous edit');
  });

  it('an identical-identity edit is a no-op update, never ambiguous', async () => {
    const res = await client.patch(`/api/entries/600?year=${year}`, {
      body: { num: 600, univ: 'IdUnivA', team: 'IdTeamA' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200, 'unchanged identity must not be reported ambiguous');
  });

  it('retain intent updates identity with a plain 200', async () => {
    const res = await client.patch(`/api/entries/600?year=${year}`, {
      body: { num: 600, univ: 'IdUnivB', team: 'IdTeamB', intent: 'retain' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    const data = await (await client.get(`/api/entries?year=${year}`)).json();
    assert.equal(data['600'].team, 'IdTeamB', 'entry identity is updated');
  });

  it('replacement intent updates identity with a plain 200', async () => {
    const res = await client.patch(`/api/entries/600?year=${year}`, {
      body: { num: 600, univ: 'IdUnivC', team: 'IdTeamC', intent: 'replacement' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    const data = await (await client.get(`/api/entries?year=${year}`)).json();
    assert.equal(data['600'].team, 'IdTeamC', 'entry table holds the new team');
  });
});

// ─── Renumber combined with an identity change ───────────────────────────
describe('PATCH /api/entries/:num — renumber with identity change', () => {
  const year = 2054;

  before(async () => {
    const res = await client.post(`/api/entries?year=${year}`, {
      body: { num: 610, univ: 'RenUnivA', team: 'RenTeamA' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
  });

  it('rejects a combined renumber + identity change without intent (409)', async () => {
    const res = await client.patch(`/api/entries/610?year=${year}`, {
      body: { num: 611, univ: 'RenUnivB', team: 'RenTeamB' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 409);

    const data = await (await client.get(`/api/entries?year=${year}`)).json();
    assert.equal(data['611'], undefined, 'nothing moved on the rejected request');
    assert.equal(data['610'].team, 'RenTeamA', 'the original row is untouched');
  });

  it('retain intent allows the combined change and keeps the immutable id', async () => {
    const before = await (await client.get(`/api/entries?year=${year}`)).json();

    const res = await client.patch(`/api/entries/610?year=${year}`, {
      body: { num: 611, univ: 'RenUnivB', team: 'RenTeamB', intent: 'retain' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    const data = await (await client.get(`/api/entries?year=${year}`)).json();
    assert.equal(data['610'], undefined);
    assert.equal(data['611'].team, 'RenTeamB');
    assert.equal(data['611'].id, before['610'].id, 'a name correction moved with the number keeps the id');
  });
});

// ─── Bulk upload team matching (route-level semantics) ───────────────────
// 각 it은 자기 연도를 써서 서로 격리한다. 다운스트림 반영은 pull 기반이므로 여기서는
// entry 자신의 테이블 상태와 tombstone만 본다.
describe('POST /api/entries/bulk — team matching semantics', () => {
  async function bulkUpload(year, data, extra = {}) {
    return client.post(`/api/entries/bulk?year=${year}`, {
      body: { data, ...extra },
      cookie: adminCookie,
    });
  }

  async function getEntries(year) {
    const res = await client.get(`/api/entries?year=${year}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    return res.json();
  }

  it('accepts an explicit renumber mapping when display names also change', async () => {
    const year = 2055;
    assert.equal((await bulkUpload(year, { 330: { univ: 'BulkMapUnivOld', team: 'BulkMapTeamOld' } })).status, 200);
    const before = await getEntries(year);

    const res = await bulkUpload(year,
      { 331: { univ: 'BulkMapUnivNew', team: 'BulkMapTeamNew' } },
      { renumbers: { 330: 331 } },
    );
    assert.equal(res.status, 200);

    const after = await getEntries(year);
    assert.equal(after['330'], undefined);
    assert.equal(after['331'].team, 'BulkMapTeamNew');
    assert.equal(after['331'].id, before['330'].id, 'an explicit renumber inherits the immutable id');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM team_tombstone WHERE year = ?').get(year).c,
      0,
      'an explicitly renumbered team is not tombstoned',
    );
  });

  it('rejects a self-map renumber so it cannot bypass the same-number ambiguity guard', async () => {
    const year = 2056;
    assert.equal((await bulkUpload(year, { 340: { univ: 'SelfMapUnivA', team: 'SelfMapTeamA' } })).status, 200);

    // self-map(340→340)을 explicit renumber로 실으면 ambiguous 검사를 우회해
    // downstream 데이터가 새 팀에 조용히 승계될 수 있었다. 400으로 거부되어야 한다.
    const res = await bulkUpload(year,
      { 340: { univ: 'SelfMapUnivB', team: 'SelfMapTeamB' } },
      { renumbers: { 340: 340 } },
    );
    assert.equal(res.status, 400, 'self-map renumber must be rejected');

    const after = await getEntries(year);
    assert.equal(after['340'].team, 'SelfMapTeamA', 'entry table is unchanged on a rejected self-map');
  });

  it('rejects an undeclared same-number team change with 409 and leaves the table untouched', async () => {
    const year = 2057;
    assert.equal((await bulkUpload(year, { 306: { univ: 'BulkAmbigUnivA', team: 'BulkAmbigTeamA' } })).status, 200);
    const before = await getEntries(year);

    const res = await bulkUpload(year, { 306: { univ: 'BulkAmbigUnivB', team: 'BulkAmbigTeamB' } });
    assert.equal(res.status, 409);
    const payload = await res.json();
    assert.ok(Array.isArray(payload.ambiguous), 'response carries the ambiguous list');
    const entry = payload.ambiguous.find(a => a.num === 306);
    assert.ok(entry, '306 reported as ambiguous');
    assert.equal(entry.from.team, 'BulkAmbigTeamA');
    assert.equal(entry.to.team, 'BulkAmbigTeamB');

    const after = await getEntries(year);
    assert.equal(after['306'].team, 'BulkAmbigTeamA', 'entry table is unchanged on a 409');
    assert.equal(after['306'].id, before['306'].id, 'the original team keeps its id');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM team_tombstone WHERE year = ?').get(year).c,
      0,
      'nothing is tombstoned while the change is unresolved',
    );
  });

  it('a same-number change declared a name correction (retains) is a retained entry', async () => {
    const year = 2058;
    assert.equal((await bulkUpload(year, { 305: { univ: 'BulkCorrectUniv', team: 'BulkCorrectTeam' } })).status, 200);
    const before = await getEntries(year);

    const res = await bulkUpload(year,
      { 305: { univ: 'BulkCorrectUnivFixed', team: 'BulkCorrectTeamFixed' } },
      { retains: [305] },
    );
    assert.equal(res.status, 200);

    const after = await getEntries(year);
    assert.equal(after['305'].team, 'BulkCorrectTeamFixed');
    assert.equal(after['305'].id, before['305'].id, 'a declared name correction keeps the immutable id');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM team_tombstone WHERE year = ?').get(year).c,
      0,
      'a name correction is not tombstoned',
    );
  });

  it('swaps two numbers; each id follows its team', async () => {
    const year = 2059;
    assert.equal((await bulkUpload(year, {
      310: { univ: 'BulkSwapUnivA', team: 'BulkSwapTeamA' },
      311: { univ: 'BulkSwapUnivB', team: 'BulkSwapTeamB' },
    })).status, 200);
    const before = await getEntries(year);

    const res = await bulkUpload(year, {
      310: { univ: 'BulkSwapUnivB', team: 'BulkSwapTeamB' },
      311: { univ: 'BulkSwapUnivA', team: 'BulkSwapTeamA' },
    });
    assert.equal(res.status, 200);

    const after = await getEntries(year);
    assert.equal(after['310'].team, 'BulkSwapTeamB');
    assert.equal(after['311'].team, 'BulkSwapTeamA');
    assert.equal(after['310'].id, before['311'].id, 'the id follows the team through a swap');
    assert.equal(after['311'].id, before['310'].id, 'the id follows the team through a swap');
  });

  it('tombstones a displaced team when another team renumbers into its number', async () => {
    const year = 2060;
    assert.equal((await bulkUpload(year, {
      320: { univ: 'BulkDisplaceUnivA', team: 'BulkDisplaceTeamA' },
      321: { univ: 'BulkDisplaceUnivB', team: 'BulkDisplaceTeamB' },
    })).status, 200);
    const before = await getEntries(year);

    const res = await bulkUpload(year, {
      321: { univ: 'BulkDisplaceUnivA', team: 'BulkDisplaceTeamA' },
    });
    assert.equal(res.status, 200);

    const after = await getEntries(year);
    assert.equal(after['320'], undefined);
    assert.equal(after['321'].team, 'BulkDisplaceTeamA');
    assert.equal(after['321'].id, before['320'].id, 'the moved team keeps its id at the reused number');
    const tombstoned = db.prepare('SELECT team_id FROM team_tombstone WHERE year = ?').all(year).map(r => r.team_id);
    assert.deepEqual(tombstoned, [before['321'].id], 'only the displaced team is tombstoned');
  });
});

// ─── Entry active state ──────────────────────────────────────────────────
describe('Entry active state', () => {
  it('hides inactive entries by default and exposes them only to an admin query', async () => {
    const year = 2061;
    const created = await client.post(`/api/entries?year=${year}`, {
      body: { num: 990, univ: 'Inactive Univ', team: 'Inactive Team' },
      cookie: adminCookie,
    });
    assert.equal(created.status, 201);

    const deactivate = await client.patch(`/api/entries/990/active?year=${year}`, {
      body: { active: false },
      cookie: adminCookie,
    });
    assert.equal(deactivate.status, 200);

    const publicEntries = await (await client.get(`/api/entries?year=${year}`)).json();
    assert.equal(publicEntries['990'], undefined);

    const unauthorized = await client.get(`/api/entries?year=${year}&includeInactive=true`);
    assert.equal(unauthorized.status, 401);

    const allEntries = await (await client.get(`/api/entries?year=${year}&includeInactive=true`, { cookie: adminCookie })).json();
    assert.equal(allEntries['990'].active, false);

    const activate = await client.patch(`/api/entries/990/active?year=${year}`, {
      body: { active: true },
      cookie: adminCookie,
    });
    assert.equal(activate.status, 200);
    const restored = await (await client.get(`/api/entries?year=${year}`)).json();
    assert.equal(restored['990'].active, true);
  });

  it('rejects a non-boolean active flag', async () => {
    const year = 2061;
    const res = await client.patch(`/api/entries/990/active?year=${year}`, {
      body: { active: 'yes' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('bulk upload reactivates retained and duplicate-identity teams absent an active flag', async () => {
    const year = 2088;
    const seeded = await client.post(`/api/entries/bulk?year=${year}`, {
      body: {
        data: {
          991: { univ: 'Retained Univ', team: 'Retained Team' },
          992: { univ: 'Duplicate Univ', team: 'Duplicate Team' },
          993: { univ: 'Duplicate Univ', team: 'Duplicate Team' },
        },
      },
      cookie: adminCookie,
    });
    assert.equal(seeded.status, 200);
    assert.equal((await client.patch(`/api/entries/991/active?year=${year}`, {
      body: { active: false }, cookie: adminCookie,
    })).status, 200);
    assert.equal((await client.patch(`/api/entries/992/active?year=${year}`, {
      body: { active: false }, cookie: adminCookie,
    })).status, 200);

    const uploaded = await client.post(`/api/entries/bulk?year=${year}`, {
      body: {
        data: {
          991: { univ: 'Retained Univ Renamed', team: 'Retained Team Renamed' },
          992: { univ: 'Duplicate Univ', team: 'Duplicate Team' },
          993: { univ: 'Duplicate Univ', team: 'Duplicate Team' },
        },
        retains: [991],
      },
      cookie: adminCookie,
    });
    assert.equal(uploaded.status, 200);

    const rows = await (await client.get(`/api/entries?year=${year}`, { cookie: adminCookie })).json();
    assert.equal(rows['991'].active, true);
    assert.equal(rows['992'].active, true);
  });

  it('bulk upload applies an explicit active: false to a renumbered team', async () => {
    const year = 2089;
    const seeded = await client.post(`/api/entries/bulk?year=${year}`, {
      body: { data: { 994: { univ: 'Move Inactive Univ', team: 'Move Inactive Team' } } },
      cookie: adminCookie,
    });
    assert.equal(seeded.status, 200);

    const uploaded = await client.post(`/api/entries/bulk?year=${year}`, {
      body: { data: { 995: { univ: 'Move Inactive Univ', team: 'Move Inactive Team', active: false } } },
      cookie: adminCookie,
    });
    assert.equal(uploaded.status, 200);

    const rows = await (await client.get(`/api/entries?year=${year}&includeInactive=true`, { cookie: adminCookie })).json();
    assert.equal(rows['994'], undefined);
    assert.equal(rows['995'].active, false, 'the renumbered team carries the uploaded active state');
  });
});
