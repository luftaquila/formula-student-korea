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
  TRUST_JWT,
  startFakeEntryServer,
} from '../helpers/test-utils.mjs';

setupTestEnv();

import { createInspectionApp } from '../../inspection/index.mjs';

const CURRENT_YEAR = new Date().getFullYear();
const PREV_YEAR = CURRENT_YEAR - 1;

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });
const chiefCookie = makeAuthCookie({ email: 'chief@test.com', name: 'Chief', role: 'chief' });
const officialCookie = makeAuthCookie({ email: 'official@test.com', name: 'Official', role: 'official' });

let server, baseUrl, client, db, dbPath;

before(async () => {
  // 메인 스위트는 entry 없이 돈다 — 캐시 미로드 = 전원 활성(fail-open)이 기존
  // team_status 부재 시맨틱과 동일함을 그대로 검증한다. 백그라운드 refresh가
  // 즉시 실패하도록 도달 불가 주소를 명시한다.
  process.env.ENTRY_SERVER = 'http://127.0.0.1:1';
  dbPath = tmpDbPath();
  const result = createInspectionApp({ dbPath, skipTeamStateSync: true, validateUser: TRUST_JWT });
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

// ─── Health ─────────────────────────────────────────────────────────────
describe('GET /api/health', () => {
  it('returns 200 "ok"', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'ok');
  });
});

// ─── Template CRUD ──────────────────────────────────────────────────────
describe('Template CRUD', () => {
  let categoryId, subcategoryId, groupId, itemId;

  it('GET /api/sheet/template?year=CURRENT_YEAR returns empty array initially', async () => {
    const res = await client.get(`/api/sheet/template?year=${CURRENT_YEAR}`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
  });

  it('POST /api/sheet/template creates category (requires chief)', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'Mechanical' },
      cookie: chiefCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    categoryId = Number(data.id);
  });

  it('POST /api/sheet/template creates subcategory with parent_id', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: categoryId, name: 'Brakes' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    subcategoryId = Number(data.id);
  });

  it('POST /api/sheet/template creates group under subcategory', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subcategoryId, name: 'Brake Lines' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    groupId = Number(data.id);
  });

  it('POST /api/sheet/template creates item under group with answer_type', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: groupId, name: 'Brake fluid level', answer_type: 'passfail' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    itemId = Number(data.id);
  });

  it('POST /api/sheet/template rejects missing required fields (400)', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('GET /api/sheet/template?year=CURRENT_YEAR returns tree structure', async () => {
    const res = await client.get(`/api/sheet/template?year=${CURRENT_YEAR}`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const tree = await res.json();
    assert.ok(Array.isArray(tree));
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, 'Mechanical');
    assert.equal(tree[0].level, 'category');
    assert.ok(Array.isArray(tree[0].subcategories));
    assert.equal(tree[0].subcategories.length, 1);
    assert.equal(tree[0].subcategories[0].name, 'Brakes');
    assert.ok(Array.isArray(tree[0].subcategories[0].groups));
    assert.equal(tree[0].subcategories[0].groups.length, 1);
    assert.equal(tree[0].subcategories[0].groups[0].name, 'Brake Lines');
    assert.ok(Array.isArray(tree[0].subcategories[0].groups[0].items));
    assert.equal(tree[0].subcategories[0].groups[0].items.length, 1);
    assert.equal(tree[0].subcategories[0].groups[0].items[0].name, 'Brake fluid level');
  });

  it('GET /api/sheet/template rejects missing year (400)', async () => {
    const res = await client.get('/api/sheet/template', { cookie: officialCookie });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/template/:id updates category fields together', async () => {
    const res = await client.put(`/api/sheet/template/${categoryId}`, {
      body: { name: 'Mechanical Inspection', sort_order: 5 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    const getRes = await client.get(`/api/sheet/template?year=${CURRENT_YEAR}`, { cookie: officialCookie });
    const tree = await getRes.json();
    const category = tree.find(node => Number(node.id) === categoryId);
    assert.equal(category.name, 'Mechanical Inspection');
    assert.equal(category.sort_order, 5);
  });

  it('PUT /api/sheet/template/:id updates item fields together', async () => {
    const res = await client.put(`/api/sheet/template/${itemId}`, {
      body: { answer_type: 'number', remarks: 'Check carefully', unit: 'mm', pdf_include: 0 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    const tree = await (await client.get(`/api/sheet/template?year=${CURRENT_YEAR}`, { cookie: officialCookie })).json();
    const item = tree
      .flatMap(category => category.subcategories)
      .flatMap(subcategory => subcategory.groups)
      .flatMap(group => group.items)
      .find(node => Number(node.id) === itemId);
    assert.equal(item.answer_type, 'number');
    assert.equal(item.remarks, 'Check carefully');
    assert.equal(item.unit, 'mm');
    assert.equal(item.pdf_include, 0);
  });

  it('PUT /api/sheet/template/:id rejects no fields (400)', async () => {
    const res = await client.put(`/api/sheet/template/${categoryId}`, {
      body: {},
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/template/:id returns 404 for non-existent', async () => {
    const res = await client.put('/api/sheet/template/99999', {
      body: { name: 'Ghost' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });

  it('DELETE /api/sheet/template/:id deletes node (CASCADE)', async () => {
    // Create a throwaway category + subcategory, then delete the category
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'TempCat' },
      cookie: adminCookie,
    });
    const catData = await catRes.json();
    const tempCatId = Number(catData.id);

    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: tempCatId, name: 'TempSub' },
      cookie: adminCookie,
    });
    const subData = await subRes.json();
    const tempSubId = Number(subData.id);

    // Delete parent → child should cascade
    const delRes = await client.delete(`/api/sheet/template/${tempCatId}`, { cookie: adminCookie });
    assert.equal(delRes.status, 200);

    // Verify child is gone too
    const tree = await (await client.get(`/api/sheet/template?year=${CURRENT_YEAR}`, { cookie: officialCookie })).json();
    const ids = [];
    for (const cat of tree) {
      ids.push(cat.id);
      for (const sub of cat.subcategories || []) ids.push(sub.id);
    }
    assert.ok(!ids.includes(tempCatId));
    assert.ok(!ids.includes(tempSubId));
  });

  it('DELETE /api/sheet/template/:id blocks previous year deletion', async () => {
    // Insert a previous-year node directly into the DB
    const info = db.prepare(
      "INSERT INTO sheet_template (year, level, name, sort_order) VALUES (?, 'category', 'OldCat', 0)"
    ).run(PREV_YEAR);
    const oldId = Number(info.lastInsertRowid);

    const res = await client.delete(`/api/sheet/template/${oldId}`, { cookie: adminCookie });
    assert.equal(res.status, 400);

    // Clean up
    db.prepare("DELETE FROM sheet_template WHERE id = ?").run(oldId);
  });

  it('DELETE /api/sheet/template/:id returns 404 for non-existent', async () => {
    const res = await client.delete('/api/sheet/template/99999', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

// ─── Reorder ────────────────────────────────────────────────────────────
describe('Template Reorder', () => {
  it('POST /api/sheet/template/reorder reorders items', async () => {
    // Create two categories to reorder
    const r1 = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'ReorderA', sort_order: 0 },
      cookie: adminCookie,
    });
    const r2 = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'ReorderB', sort_order: 1 },
      cookie: adminCookie,
    });
    const id1 = Number((await r1.json()).id);
    const id2 = Number((await r2.json()).id);

    const res = await client.post('/api/sheet/template/reorder', {
      body: { items: [{ id: id1, sort_order: 1 }, { id: id2, sort_order: 0 }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    const tree = await (await client.get(`/api/sheet/template?year=${CURRENT_YEAR}`, { cookie: officialCookie })).json();
    assert.deepEqual(
      tree.filter(node => ['ReorderA', 'ReorderB'].includes(node.name)).map(node => node.name),
      ['ReorderB', 'ReorderA']
    );

    // Clean up
    await client.delete(`/api/sheet/template/${id1}`, { cookie: adminCookie });
    await client.delete(`/api/sheet/template/${id2}`, { cookie: adminCookie });
  });

  it('POST /api/sheet/template/reorder rejects non-array (400)', async () => {
    const res = await client.post('/api/sheet/template/reorder', {
      body: { items: 'not-array' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/sheet/template/reorder rejects invalid items (400)', async () => {
    const res = await client.post('/api/sheet/template/reorder', {
      body: { items: [{ id: 'abc', sort_order: 'xyz' }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/sheet/template/reorder rejects >1000 items', async () => {
    const items = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, sort_order: i }));
    const res = await client.post('/api/sheet/template/reorder', {
      body: { items },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Copy ───────────────────────────────────────────────────────────────
describe('Template Copy', () => {
  const SOURCE_YEAR = CURRENT_YEAR + 100;
  const TARGET_YEAR = CURRENT_YEAR + 101;

  before(async () => {
    // Seed source year with a category
    await client.post('/api/sheet/template', {
      body: { year: SOURCE_YEAR, level: 'category', name: 'CopyCat', pdf_include: 0 },
      cookie: adminCookie,
    });
  });

  after(async () => {
    // Clean up both years
    db.prepare("DELETE FROM sheet_template WHERE year IN (?, ?)").run(SOURCE_YEAR, TARGET_YEAR);
  });

  it('POST /api/sheet/template/copy copies template between years', async () => {
    const res = await client.post('/api/sheet/template/copy', {
      body: { from_year: SOURCE_YEAR, to_year: TARGET_YEAR },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);

    // Verify target has data
    const tree = await (await client.get(`/api/sheet/template?year=${TARGET_YEAR}`, { cookie: officialCookie })).json();
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, 'CopyCat');
    assert.equal(tree[0].pdf_include, 0);
  });

  it('POST /api/sheet/template/copy rejects if target year already has data (400)', async () => {
    const res = await client.post('/api/sheet/template/copy', {
      body: { from_year: SOURCE_YEAR, to_year: TARGET_YEAR },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/sheet/template/copy rejects if source year is empty (400)', async () => {
    const EMPTY_YEAR = CURRENT_YEAR + 200;
    const res = await client.post('/api/sheet/template/copy', {
      body: { from_year: EMPTY_YEAR, to_year: CURRENT_YEAR + 201 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Import ─────────────────────────────────────────────────────────────
describe('Template Import', () => {
  const IMPORT_YEAR = CURRENT_YEAR + 300;

  after(async () => {
    db.prepare("DELETE FROM sheet_template WHERE year = ?").run(IMPORT_YEAR);
  });

  it('POST /api/sheet/template/import imports template from JSON', async () => {
    const template = [
      {
        name: 'ImportedCat',
        subcategories: [
          {
            name: 'ImportedSub',
            groups: [
              {
                name: 'ImportedGroup',
                items: [
                  { name: 'ImportedItem', answer_type: 'passfail' },
                ],
              },
            ],
          },
        ],
      },
    ];
    const res = await client.post('/api/sheet/template/import', {
      body: { year: IMPORT_YEAR, template },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);

    // Verify imported structure
    const tree = await (await client.get(`/api/sheet/template?year=${IMPORT_YEAR}`, { cookie: officialCookie })).json();
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, 'ImportedCat');
    assert.equal(tree[0].subcategories[0].name, 'ImportedSub');
    assert.equal(tree[0].subcategories[0].groups[0].name, 'ImportedGroup');
    assert.equal(tree[0].subcategories[0].groups[0].items[0].name, 'ImportedItem');
  });

  it('POST /api/sheet/template/import rejects missing fields (400)', async () => {
    const res = await client.post('/api/sheet/template/import', {
      body: { year: IMPORT_YEAR },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Configurable calculated fields ────────────────────────────────────
describe('Configurable calculated fields', () => {
  const CALC_YEAR = CURRENT_YEAR + 600;
  const COPY_YEAR = CALC_YEAR + 1;
  const IMPORT_YEAR = CALC_YEAR + 2;
  let groupId, sourceId, sourceKey, computedId, computedKey, suggestionId;

  before(async () => {
    const cat = await client.post('/api/sheet/template', {
      body: { year: CALC_YEAR, level: 'category', name: 'Calculated fields' }, cookie: adminCookie,
    });
    const categoryId = Number((await cat.json()).id);
    const sub = await client.post('/api/sheet/template', {
      body: { year: CALC_YEAR, level: 'subcategory', parent_id: categoryId, name: 'Electrical' }, cookie: adminCookie,
    });
    const subcategoryId = Number((await sub.json()).id);
    const group = await client.post('/api/sheet/template', {
      body: { year: CALC_YEAR, level: 'group', parent_id: subcategoryId, name: 'IMD' }, cookie: adminCookie,
    });
    groupId = Number((await group.json()).id);

    const source = await client.post('/api/sheet/template', {
      body: { year: CALC_YEAR, level: 'item', parent_id: groupId, name: 'Current voltage', answer_type: 'number' },
      cookie: adminCookie,
    });
    const sourceBody = await source.json();
    sourceId = Number(sourceBody.id);
    sourceKey = sourceBody.field_key;
  });

  after(() => {
    db.prepare('DELETE FROM sheet_template WHERE year IN (?, ?, ?)').run(CALC_YEAR, COPY_YEAR, IMPORT_YEAR);
  });

  it('creates and returns a computed field configuration', async () => {
    const response = await client.post('/api/sheet/template', {
      body: {
        year: CALC_YEAR,
        level: 'item',
        parent_id: groupId,
        name: 'IMD test resistance',
        answer_type: 'number',
        calculation: { mode: 'computed', operation: 'multiply', sources: [sourceKey], factor: 250, precision: 2 },
      },
      cookie: adminCookie,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    computedId = Number(body.id);
    computedKey = body.field_key;

    const tree = await (await client.get(`/api/sheet/template?year=${CALC_YEAR}`, { cookie: officialCookie })).json();
    const target = tree[0].subcategories[0].groups[0].items.find(item => item.id === computedId);
    assert.deepEqual(target.calculation, {
      mode: 'computed', operation: 'multiply', sources: [sourceKey], precision: 2, factor: 250,
    });
  });

  it('rejects direct answers for computed fields but accepts source answers', async () => {
    const sourceResponse = await client.put('/api/sheet/answer', {
      body: { year: CALC_YEAR, team_num: 1, item_id: sourceId, value: '421.5' }, cookie: officialCookie,
    });
    assert.equal(sourceResponse.status, 200);

    const targetResponse = await client.put('/api/sheet/answer', {
      body: { year: CALC_YEAR, team_num: 1, item_id: computedId, value: '105375' }, cookie: officialCookie,
    });
    assert.equal(targetResponse.status, 400);
    assert.match(await targetResponse.text(), /자동 계산 문항/);
  });

  it('shows a suggestion while preserving a manually measured answer', async () => {
    const response = await client.post('/api/sheet/template', {
      body: {
        year: CALC_YEAR,
        level: 'item',
        parent_id: groupId,
        name: 'TSMP resistance',
        answer_type: 'number',
        calculation: {
          mode: 'suggestion', operation: 'range_lookup', sources: [sourceKey], precision: 0,
          ranges: [{ max: 200, value: 5 }, { max: 400, value: 10 }, { max: 600, value: 15 }],
        },
      },
      cookie: adminCookie,
    });
    assert.equal(response.status, 200);
    suggestionId = Number((await response.json()).id);

    const answer = await client.put('/api/sheet/answer', {
      body: { year: CALC_YEAR, team_num: 1, item_id: suggestionId, value: '10.4' }, cookie: officialCookie,
    });
    assert.equal(answer.status, 200);
    const data = await (await client.get(`/api/sheet/data/${CALC_YEAR}/1`, { cookie: officialCookie })).json();
    assert.equal(data.answers[suggestionId].value, '10.4');
  });

  it('rejects cyclic links and deleting a referenced source', async () => {
    const cycle = await client.put(`/api/sheet/template/${sourceId}`, {
      body: { calculation: { mode: 'computed', operation: 'sum', sources: [computedKey], precision: 2 } },
      cookie: adminCookie,
    });
    assert.equal(cycle.status, 400);
    assert.match(await cycle.text(), /순환 참조/);

    const remove = await client.delete(`/api/sheet/template/${sourceId}`, { cookie: adminCookie });
    assert.equal(remove.status, 400);
    assert.match(await remove.text(), /원본 문항/);
  });

  it('preserves field keys and calculation metadata when copying a year', async () => {
    const copy = await client.post('/api/sheet/template/copy', {
      body: { from_year: CALC_YEAR, to_year: COPY_YEAR }, cookie: adminCookie,
    });
    assert.equal(copy.status, 201);
    const tree = await (await client.get(`/api/sheet/template?year=${COPY_YEAR}`, { cookie: officialCookie })).json();
    const items = tree[0].subcategories[0].groups[0].items;
    assert.ok(items.some(item => item.field_key === sourceKey));
    assert.equal(items.find(item => item.field_key === computedKey).calculation.sources[0], sourceKey);
  });

  it('round-trips calculation metadata through JSON import', async () => {
    const importTemplate = [{
      name: 'Import', subcategories: [{ name: 'Sub', groups: [{ name: 'Group', items: [
        { name: 'Source', answer_type: 'number', field_key: 'import-source' },
        {
          name: 'Recommendation', answer_type: 'number', field_key: 'import-target',
          calculation: { mode: 'suggestion', operation: 'multiply', sources: ['import-source'], factor: 2, precision: 1 },
        },
      ] }] }],
    }];
    const response = await client.post('/api/sheet/template/import', {
      body: { year: IMPORT_YEAR, template: importTemplate }, cookie: adminCookie,
    });
    assert.equal(response.status, 201);
    const tree = await (await client.get(`/api/sheet/template?year=${IMPORT_YEAR}`, { cookie: officialCookie })).json();
    const target = tree[0].subcategories[0].groups[0].items[1];
    assert.equal(target.field_key, 'import-target');
    assert.deepEqual(target.calculation.sources, ['import-source']);
  });
});

// ─── Per-vehicle-type category visibility ────────────────────────────────
// excluded_types는 카테고리를 숨길 차량 유형 이름 목록이다(제외 저장 → 기본은 전체 표시).
describe('Category excluded_types', () => {
  const VT_YEAR = CURRENT_YEAR + 400;

  after(async () => {
    db.prepare("DELETE FROM sheet_template WHERE year IN (?, ?)").run(VT_YEAR, VT_YEAR + 1);
  });

  async function createCategory(name, body = {}) {
    const res = await client.post('/api/sheet/template', {
      body: { year: VT_YEAR, level: 'category', name, ...body },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    return Number((await res.json()).id);
  }

  async function getTree(year = VT_YEAR) {
    return (await client.get(`/api/sheet/template?year=${year}`, { cookie: officialCookie })).json();
  }

  it('defaults to an empty array so a new category shows for every type', async () => {
    const id = await createCategory('DefaultVisible');
    const cat = (await getTree()).find(c => c.id === id);
    assert.deepEqual(cat.excluded_types, []);
  });

  it('POST accepts excluded_types and GET returns it as an array', async () => {
    const id = await createCategory('EFormulaOnly', { excluded_types: ['C-Formula'] });
    const cat = (await getTree()).find(c => c.id === id);
    assert.deepEqual(cat.excluded_types, ['C-Formula']);
  });

  it('POST rejects a non-array excluded_types (400)', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: VT_YEAR, level: 'category', name: 'BadTypes', excluded_types: 'C-Formula' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT replaces excluded_types, trimming and de-duplicating names', async () => {
    const id = await createCategory('Updatable');
    const res = await client.put(`/api/sheet/template/${id}`, {
      body: { excluded_types: [' C-Formula ', 'C-Formula', 'E-Formula', ''] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const cat = (await getTree()).find(c => c.id === id);
    assert.deepEqual(cat.excluded_types, ['C-Formula', 'E-Formula']);
  });

  it('PUT with an empty array clears the exclusions', async () => {
    const id = await createCategory('Clearable', { excluded_types: ['C-Formula'] });
    const res = await client.put(`/api/sheet/template/${id}`, {
      body: { excluded_types: [] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const cat = (await getTree()).find(c => c.id === id);
    assert.deepEqual(cat.excluded_types, []);
  });

  it('PUT rejects a non-array excluded_types (400)', async () => {
    const id = await createCategory('RejectUpdate');
    const res = await client.put(`/api/sheet/template/${id}`, {
      body: { excluded_types: { 'C-Formula': true } },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT rejects more than 50 excluded types (400)', async () => {
    const id = await createCategory('TooManyTypes');
    const res = await client.put(`/api/sheet/template/${id}`, {
      body: { excluded_types: Array.from({ length: 51 }, (_, i) => `Type${i}`) },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('non-category levels report an empty array rather than the raw stored value', async () => {
    const catId = await createCategory('WithChildren');
    const subRes = await client.post('/api/sheet/template', {
      body: { year: VT_YEAR, level: 'subcategory', parent_id: catId, name: 'ChildSub' },
      cookie: adminCookie,
    });
    assert.equal(subRes.status, 200);
    const cat = (await getTree()).find(c => c.id === catId);
    assert.deepEqual(cat.subcategories[0].excluded_types, []);
  });

  it('a corrupted stored value degrades to "shown for every type"', async () => {
    const id = await createCategory('CorruptedValue');
    db.prepare("UPDATE sheet_template SET excluded_types = ? WHERE id = ?").run('not json', id);
    const cat = (await getTree()).find(c => c.id === id);
    assert.deepEqual(cat.excluded_types, []);
  });

  it('GET /api/sheet/summary exposes excluded_types per category', async () => {
    const id = await createCategory('SummaryCat', { excluded_types: ['C-Formula'] });
    const res = await client.get(`/api/sheet/summary?year=${VT_YEAR}`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const cat = data.categories.find(c => c.id === id);
    assert.deepEqual(cat.excluded_types, ['C-Formula']);
  });

  it('cross-year copy carries excluded_types over (names, not ids)', async () => {
    const res = await client.post('/api/sheet/template/copy', {
      body: { from_year: VT_YEAR, to_year: VT_YEAR + 1 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const copied = (await getTree(VT_YEAR + 1)).find(c => c.name === 'EFormulaOnly');
    assert.deepEqual(copied.excluded_types, ['C-Formula']);
  });

  it('JSON import restores excluded_types', async () => {
    const res = await client.post('/api/sheet/template/import', {
      body: {
        year: VT_YEAR,
        template: [{ name: 'ImportedTyped', excluded_types: ['E-Formula'], subcategories: [] }],
      },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);
    const tree = await getTree();
    assert.equal(tree.length, 1);
    assert.deepEqual(tree[0].excluded_types, ['E-Formula']);
  });
});

// ─── Answer CRUD ────────────────────────────────────────────────────────
describe('Answer CRUD', () => {
  let answerItemId, answerCategoryId;

  before(async () => {
    // Create a full template tree for answer tests
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'AnswerCat' },
      cookie: adminCookie,
    });
    answerCategoryId = Number((await catRes.json()).id);

    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: answerCategoryId, name: 'AnswerSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);

    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'AnswerGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);

    const itemRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'AnswerItem', answer_type: 'passfail' },
      cookie: adminCookie,
    });
    answerItemId = Number((await itemRes.json()).id);
  });

  it('PUT /api/sheet/answer upserts answer (requires official)', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: answerItemId, value: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    const saved = await res.json();
    assert.equal(saved.value, 'PASS');
    assert.equal(saved.version, 1);
    const data = await (await client.get(`/api/sheet/data/${CURRENT_YEAR}/1`, { cookie: officialCookie })).json();
    assert.equal(data.answers[answerItemId].value, 'PASS');
  });

  it('PUT /api/sheet/answer validates passfail type (only PASS/FAIL/"")', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: answerItemId, value: 'INVALID' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/answer rejects missing fields (400)', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/answer rejects previous year (400)', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: PREV_YEAR, team_num: 1, item_id: answerItemId, value: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/answer rejects non-existent item (400)', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: 99999, value: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/answer keeps version metadata stable when value is unchanged', async () => {
    const first = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 99, item_id: answerItemId, value: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(first.status, 200);
    const firstData = await first.json();

    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 99, item_id: answerItemId, value: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    const unchanged = await res.json();
    assert.deepEqual(unchanged, firstData);
  });

  it('PUT /api/sheet/answer increments versions and rejects a stale base_version', async () => {
    const first = await client.put('/api/sheet/answer', {
      body: {
        year: CURRENT_YEAR,
        team_num: 77,
        item_id: answerItemId,
        value: 'PASS',
        base_version: 0,
        mutation_id: 'answer-v1',
      },
      cookie: officialCookie,
    });
    assert.equal(first.status, 200);
    const firstData = await first.json();
    assert.equal(firstData.version, 1);
    assert.equal(firstData.updated_by, 'Official');
    assert.equal(firstData.mutation_id, 'answer-v1');

    const stale = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 77, item_id: answerItemId, value: 'FAIL', base_version: 0 },
      cookie: officialCookie,
    });
    assert.equal(stale.status, 409);
    const staleData = await stale.json();
    assert.equal(staleData.current.value, 'PASS');
    assert.equal(staleData.current.version, 1);

    const next = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 77, item_id: answerItemId, value: 'FAIL', base_version: 1 },
      cookie: officialCookie,
    });
    assert.equal(next.status, 200);
    assert.equal((await next.json()).version, 2);

    const dataRes = await client.get(`/api/sheet/data/${CURRENT_YEAR}/77`, { cookie: officialCookie });
    const data = await dataRes.json();
    assert.equal(data.answers[answerItemId].value, 'FAIL');
    assert.equal(data.answers[answerItemId].answer_version, 2);
    assert.equal(data.answers[answerItemId].answer_updated_by, 'Official');
  });
});

// ─── Memo ───────────────────────────────────────────────────────────────
describe('Memo', () => {
  let memoItemId;

  before(async () => {
    // Create a template item for memo tests
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'MemoCat' },
      cookie: adminCookie,
    });
    const catId = Number((await catRes.json()).id);

    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: catId, name: 'MemoSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);

    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'MemoGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);

    const itemRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'MemoItem', answer_type: 'text' },
      cookie: adminCookie,
    });
    memoItemId = Number((await itemRes.json()).id);
  });

  it('PUT /api/sheet/memo upserts memo', async () => {
    const res = await client.put('/api/sheet/memo', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: memoItemId, memo: 'Test memo text' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    const saved = await res.json();
    assert.equal(saved.memo, 'Test memo text');
    assert.equal(saved.version, 1);
    const data = await (await client.get(`/api/sheet/data/${CURRENT_YEAR}/1`, { cookie: officialCookie })).json();
    assert.equal(data.answers[memoItemId].memo, 'Test memo text');
  });

  it('PUT /api/sheet/memo rejects missing fields (400)', async () => {
    const res = await client.put('/api/sheet/memo', {
      body: { year: CURRENT_YEAR },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/memo rejects previous year (400)', async () => {
    const res = await client.put('/api/sheet/memo', {
      body: { year: PREV_YEAR, team_num: 1, item_id: memoItemId, memo: 'Old memo' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/memo versions memo independently from the answer', async () => {
    const answerRes = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 78, item_id: memoItemId, value: 'answer', base_version: 0 },
      cookie: officialCookie,
    });
    assert.equal(answerRes.status, 200);

    const first = await client.put('/api/sheet/memo', {
      body: {
        year: CURRENT_YEAR,
        team_num: 78,
        item_id: memoItemId,
        memo: '첫 메모',
        base_version: 0,
        mutation_id: 'memo-v1',
      },
      cookie: officialCookie,
    });
    assert.equal(first.status, 200);
    const firstData = await first.json();
    assert.equal(firstData.version, 1);
    assert.equal(firstData.updated_by, 'Official');

    const unchanged = await client.put('/api/sheet/memo', {
      body: { year: CURRENT_YEAR, team_num: 78, item_id: memoItemId, memo: '첫 메모', base_version: 1 },
      cookie: officialCookie,
    });
    assert.equal(unchanged.status, 200);
    assert.equal((await unchanged.json()).version, 1);

    const stale = await client.put('/api/sheet/memo', {
      body: { year: CURRENT_YEAR, team_num: 78, item_id: memoItemId, memo: '오래된 수정', base_version: 0 },
      cookie: officialCookie,
    });
    assert.equal(stale.status, 409);
    const staleData = await stale.json();
    assert.equal(staleData.current.memo, '첫 메모');
    assert.equal(staleData.current.version, 1);

    const dataRes = await client.get(`/api/sheet/data/${CURRENT_YEAR}/78`, { cookie: officialCookie });
    const data = await dataRes.json();
    assert.equal(data.answers[memoItemId].answer_version, 1);
    assert.equal(data.answers[memoItemId].memo_version, 1);
    assert.equal(data.answers[memoItemId].memo_updated_by, 'Official');
  });
});

// ─── Category Result ────────────────────────────────────────────────────
describe('Category Result', () => {
  let resultCategoryId, resultNonCategoryId;

  before(async () => {
    // Create a category for result tests
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'ResultCat' },
      cookie: adminCookie,
    });
    resultCategoryId = Number((await catRes.json()).id);

    // Create a subcategory (non-category) for negative test
    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: resultCategoryId, name: 'ResultSub' },
      cookie: adminCookie,
    });
    resultNonCategoryId = Number((await subRes.json()).id);
  });

  it('PUT /api/sheet/category-result upserts result', async () => {
    const res = await client.put('/api/sheet/category-result', {
      body: { year: CURRENT_YEAR, team_num: 1, category_id: resultCategoryId, result: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    const data = await (await client.get(`/api/sheet/data/${CURRENT_YEAR}/1`, { cookie: officialCookie })).json();
    assert.equal(data.results[resultCategoryId], 'PASS');
  });

  it('PUT /api/sheet/category-result validates result values (PASS/FAIL/"")', async () => {
    const res = await client.put('/api/sheet/category-result', {
      body: { year: CURRENT_YEAR, team_num: 1, category_id: resultCategoryId, result: 'INVALID' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/category-result rejects non-category (400)', async () => {
    const res = await client.put('/api/sheet/category-result', {
      body: { year: CURRENT_YEAR, team_num: 1, category_id: resultNonCategoryId, result: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Inspector ──────────────────────────────────────────────────────────
describe('Inspector', () => {
  let inspectorCategoryId;

  before(async () => {
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'InspectorCat' },
      cookie: adminCookie,
    });
    inspectorCategoryId = Number((await catRes.json()).id);
  });

  it('PUT /api/sheet/inspector upserts inspector', async () => {
    const res = await client.put('/api/sheet/inspector', {
      body: { year: CURRENT_YEAR, team_num: 1, category_id: inspectorCategoryId, inspector: 'John' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    const data = await (await client.get(`/api/sheet/data/${CURRENT_YEAR}/1`, { cookie: officialCookie })).json();
    assert.equal(data.inspectors[inspectorCategoryId], 'John');
  });

  it('PUT /api/sheet/inspector rejects previous year (400)', async () => {
    // Insert a previous-year category directly for this test
    const info = db.prepare(
      "INSERT INTO sheet_template (year, level, name, sort_order) VALUES (?, 'category', 'OldInspCat', 0)"
    ).run(PREV_YEAR);
    const oldCatId = Number(info.lastInsertRowid);

    const res = await client.put('/api/sheet/inspector', {
      body: { year: PREV_YEAR, team_num: 1, category_id: oldCatId, inspector: 'Old' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);

    // Clean up
    db.prepare("DELETE FROM sheet_template WHERE id = ?").run(oldCatId);
  });
});

// ─── Data Queries ───────────────────────────────────────────────────────
describe('Data Queries', () => {
  let dataCategoryId, dataItemId;

  before(async () => {
    // Create a complete template tree and populate data
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'DataCat' },
      cookie: adminCookie,
    });
    dataCategoryId = Number((await catRes.json()).id);

    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: dataCategoryId, name: 'DataSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);

    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'DataGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);

    const itemRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'DataItem', answer_type: 'passfail' },
      cookie: adminCookie,
    });
    dataItemId = Number((await itemRes.json()).id);

    // Populate answer, category-result, inspector
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 10, item_id: dataItemId, value: 'PASS' },
      cookie: officialCookie,
    });
    await client.put('/api/sheet/category-result', {
      body: { year: CURRENT_YEAR, team_num: 10, category_id: dataCategoryId, result: 'PASS' },
      cookie: officialCookie,
    });
    await client.put('/api/sheet/inspector', {
      body: { year: CURRENT_YEAR, team_num: 10, category_id: dataCategoryId, inspector: 'DataInspector' },
      cookie: officialCookie,
    });
  });

  it('GET /api/sheet/data/:year/:num returns answers, results, inspectors', async () => {
    const res = await client.get(`/api/sheet/data/${CURRENT_YEAR}/10`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.answers);
    assert.ok(data.results);
    assert.ok(data.inspectors);
    assert.equal(data.answers[dataItemId].value, 'PASS');
    assert.equal(data.results[dataCategoryId], 'PASS');
    assert.equal(data.inspectors[dataCategoryId], 'DataInspector');
  });

  it('GET /api/sheet/summary returns team summaries', async () => {
    const res = await client.get(`/api/sheet/summary?year=${CURRENT_YEAR}`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.categories);
    assert.ok(Array.isArray(data.categories));
    assert.ok(data.teams);
    assert.ok(data.teams[10]);
    assert.equal(data.teams[10].results[dataCategoryId], 'PASS');
    assert.equal(data.teams[10].inspectors[dataCategoryId], 'DataInspector');
  });

  it('GET /api/sheet/bulk-answers returns bulk answers for item_ids', async () => {
    const res = await client.get(`/api/sheet/bulk-answers?year=${CURRENT_YEAR}&item_ids=${dataItemId}`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data[10]);
    assert.equal(data[10][dataItemId], 'PASS');
  });
});

// ─── Number/Text answer_type ─────────────────────────────────────────────
describe('Number and Text answer types', () => {
  let numberItemId, textItemId;

  before(async () => {
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'TypeTestCat' },
      cookie: adminCookie,
    });
    const catId = Number((await catRes.json()).id);
    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: catId, name: 'TypeTestSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);
    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'TypeTestGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);
    const numRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'NumItem', answer_type: 'number' },
      cookie: adminCookie,
    });
    numberItemId = Number((await numRes.json()).id);
    const txtRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'TxtItem', answer_type: 'text' },
      cookie: adminCookie,
    });
    textItemId = Number((await txtRes.json()).id);
  });

  it('stores numeric, cleared, and text values through their full transitions', async () => {
    let res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: numberItemId, value: '42.5' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).value, '42.5');

    let data = await (await client.get(`/api/sheet/data/${CURRENT_YEAR}/1`, { cookie: officialCookie })).json();
    assert.equal(data.answers[numberItemId].value, '42.5');

    res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: numberItemId, value: '' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).value, '');

    res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: textItemId, value: 'Some text answer' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).value, 'Some text answer');

    data = await (await client.get(`/api/sheet/data/${CURRENT_YEAR}/1`, { cookie: officialCookie })).json();
    assert.equal(data.answers[numberItemId].value, '');
    assert.equal(data.answers[textItemId].value, 'Some text answer');
  });
});

// ─── Counter/Stopwatch answer_type ───────────────────────────────────────
describe('Counter and Stopwatch field types', () => {
  let counterItemId, stopwatchItemId;

  before(async () => {
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'UtilityFieldCat' },
      cookie: adminCookie,
    });
    const catId = Number((await catRes.json()).id);
    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: catId, name: 'UtilityFieldSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);
    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'UtilityFieldGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);
    const counterRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'Brake attempts', answer_type: 'counter' },
      cookie: adminCookie,
    });
    assert.equal(counterRes.status, 200);
    counterItemId = Number((await counterRes.json()).id);
    const stopwatchRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'Rain test timer', answer_type: 'stopwatch' },
      cookie: adminCookie,
    });
    assert.equal(stopwatchRes.status, 200);
    stopwatchItemId = Number((await stopwatchRes.json()).id);
  });

  it('returns both new field types in the template tree', async () => {
    const res = await client.get(`/api/sheet/template?year=${CURRENT_YEAR}`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const tree = await res.json();
    const category = tree.find(cat => cat.name === 'UtilityFieldCat');
    const items = category.subcategories[0].groups[0].items;
    assert.deepEqual(items.map(item => item.answer_type), ['counter', 'stopwatch']);
  });

  it('stores non-negative integer counter values', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: counterItemId, value: '3' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);

    const dataRes = await client.get(`/api/sheet/data/${CURRENT_YEAR}/1`, { cookie: officialCookie });
    const data = await dataRes.json();
    assert.equal(data.answers[counterItemId].value, '3');
  });

  it('rejects negative, fractional, and non-numeric counter values', async () => {
    for (const value of ['-1', '1.5', 'one']) {
      const res = await client.put('/api/sheet/answer', {
        body: { year: CURRENT_YEAR, team_num: 1, item_id: counterItemId, value },
        cookie: officialCookie,
      });
      assert.equal(res.status, 400);
    }
  });

  it('does not accept an answer for a stopwatch field', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: stopwatchItemId, value: '12.3' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /응답을 저장하지 않습니다/);
  });
});

describe('Answer cleanup when utility field types change', () => {
  let counterTransitionItemId, stopwatchTransitionItemId;

  before(async () => {
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'UtilityTransitionCat' },
      cookie: adminCookie,
    });
    const catId = Number((await catRes.json()).id);
    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: catId, name: 'UtilityTransitionSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);
    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'UtilityTransitionGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);
    const counterRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'Counter transition', answer_type: 'text' },
      cookie: adminCookie,
    });
    counterTransitionItemId = Number((await counterRes.json()).id);
    const stopwatchRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'Stopwatch transition', answer_type: 'text' },
      cookie: adminCookie,
    });
    stopwatchTransitionItemId = Number((await stopwatchRes.json()).id);
  });

  it('normalizes compatible counter values and clears incompatible values without deleting memos', async () => {
    for (const [teamNum, value, memo] of [
      [501, '0007', 'leading-zero memo'],
      [502, 'not-a-number', 'invalid-value memo'],
    ]) {
      const answerRes = await client.put('/api/sheet/answer', {
        body: { year: CURRENT_YEAR, team_num: teamNum, item_id: counterTransitionItemId, value },
        cookie: officialCookie,
      });
      assert.equal(answerRes.status, 200);
      const memoRes = await client.put('/api/sheet/memo', {
        body: { year: CURRENT_YEAR, team_num: teamNum, item_id: counterTransitionItemId, memo },
        cookie: officialCookie,
      });
      assert.equal(memoRes.status, 200);
    }

    const updateRes = await client.put(`/api/sheet/template/${counterTransitionItemId}`, {
      body: { answer_type: 'counter' },
      cookie: adminCookie,
    });
    assert.equal(updateRes.status, 200);

    const normalized = await (await client.get(`/api/sheet/data/${CURRENT_YEAR}/501`, { cookie: officialCookie })).json();
    assert.equal(normalized.answers[counterTransitionItemId].value, '7');
    assert.equal(normalized.answers[counterTransitionItemId].memo, 'leading-zero memo');
    assert.equal(normalized.answers[counterTransitionItemId].answer_version, 2);
    assert.equal(normalized.answers[counterTransitionItemId].memo_version, 1);

    const cleared = await (await client.get(`/api/sheet/data/${CURRENT_YEAR}/502`, { cookie: officialCookie })).json();
    assert.equal(cleared.answers[counterTransitionItemId].value, '');
    assert.equal(cleared.answers[counterTransitionItemId].memo, 'invalid-value memo');
    assert.equal(cleared.answers[counterTransitionItemId].answer_version, 2);
    assert.equal(cleared.answers[counterTransitionItemId].memo_version, 1);
  });

  it('clears stopwatch answers permanently while preserving memos', async () => {
    const answerRes = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 503, item_id: stopwatchTransitionItemId, value: 'old response' },
      cookie: officialCookie,
    });
    assert.equal(answerRes.status, 200);
    const memoRes = await client.put('/api/sheet/memo', {
      body: { year: CURRENT_YEAR, team_num: 503, item_id: stopwatchTransitionItemId, memo: 'keep this memo' },
      cookie: officialCookie,
    });
    assert.equal(memoRes.status, 200);

    const stopwatchRes = await client.put(`/api/sheet/template/${stopwatchTransitionItemId}`, {
      body: { answer_type: 'stopwatch' },
      cookie: adminCookie,
    });
    assert.equal(stopwatchRes.status, 200);

    let data = await (await client.get(`/api/sheet/data/${CURRENT_YEAR}/503`, { cookie: officialCookie })).json();
    assert.equal(data.answers[stopwatchTransitionItemId].value, '');
    assert.equal(data.answers[stopwatchTransitionItemId].memo, 'keep this memo');
    assert.equal(data.answers[stopwatchTransitionItemId].answer_version, 2);
    assert.equal(data.answers[stopwatchTransitionItemId].memo_version, 1);

    const textRes = await client.put(`/api/sheet/template/${stopwatchTransitionItemId}`, {
      body: { answer_type: 'text' },
      cookie: adminCookie,
    });
    assert.equal(textRes.status, 200);
    data = await (await client.get(`/api/sheet/data/${CURRENT_YEAR}/503`, { cookie: officialCookie })).json();
    assert.equal(data.answers[stopwatchTransitionItemId].value, '');
    assert.equal(data.answers[stopwatchTransitionItemId].memo, 'keep this memo');
  });
});

// ─── Bulk answers filtering ──────────────────────────────────────────────
describe('Bulk answers filtering', () => {
  let filterItem1, filterItem2, filterItem3;

  before(async () => {
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'FilterCat' },
      cookie: adminCookie,
    });
    const catId = Number((await catRes.json()).id);
    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: catId, name: 'FilterSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);
    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'FilterGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);
    const i1 = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'F1', answer_type: 'text' },
      cookie: adminCookie,
    });
    filterItem1 = Number((await i1.json()).id);
    const i2 = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'F2', answer_type: 'text' },
      cookie: adminCookie,
    });
    filterItem2 = Number((await i2.json()).id);
    const i3 = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'F3', answer_type: 'text' },
      cookie: adminCookie,
    });
    filterItem3 = Number((await i3.json()).id);

    // Set answers for team 20
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 20, item_id: filterItem1, value: 'val1' },
      cookie: officialCookie,
    });
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 20, item_id: filterItem2, value: 'val2' },
      cookie: officialCookie,
    });
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 20, item_id: filterItem3, value: 'val3' },
      cookie: officialCookie,
    });
  });

  it('returns only requested item_ids', async () => {
    const res = await client.get(
      `/api/sheet/bulk-answers?year=${CURRENT_YEAR}&item_ids=${filterItem1},${filterItem3}`,
      { cookie: officialCookie },
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data[20]);
    assert.equal(data[20][filterItem1], 'val1');
    assert.equal(data[20][filterItem3], 'val3');
    assert.equal(data[20][filterItem2], undefined, 'should not include unrequested item');
  });

  it('rejects missing item_ids parameter', async () => {
    const res = await client.get(`/api/sheet/bulk-answers?year=${CURRENT_YEAR}`, { cookie: officialCookie });
    assert.equal(res.status, 400);
  });

  it('rejects missing year parameter', async () => {
    const res = await client.get(`/api/sheet/bulk-answers?item_ids=${filterItem1}`, { cookie: officialCookie });
    assert.equal(res.status, 400);
  });
});

// ─── SSE broadcast verification ──────────────────────────────────────────
describe('SSE broadcast on data changes', () => {
  let sseItemId;

  before(async () => {
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'SSECat' },
      cookie: adminCookie,
    });
    const catId = Number((await catRes.json()).id);
    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: catId, name: 'SSESub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);
    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'SSEGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);
    const itemRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'SSEItem', answer_type: 'passfail' },
      cookie: adminCookie,
    });
    sseItemId = Number((await itemRes.json()).id);
  });

  it('SSE endpoint returns event stream with init event', async () => {
    const controller = new AbortController();
    try {
      const res = await fetch(`${baseUrl}/api/sheet/events`, {
        headers: { Cookie: officialCookie },
        signal: controller.signal,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      const reader = res.body.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      assert.ok(text.includes('event: init'), 'should receive init event');
      reader.releaseLock();
    } finally {
      controller.abort();
    }
  });

  it('answer update triggers SSE broadcast', async () => {
    // Connect SSE client
    const controller = new AbortController();
    const sseRes = await fetch(`${baseUrl}/api/sheet/events`, {
      headers: { Cookie: officialCookie },
      signal: controller.signal,
    });
    const reader = sseRes.body.getReader();

    // Read past init event
    await reader.read();

    // Trigger answer update
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 50, item_id: sseItemId, value: 'PASS' },
      cookie: officialCookie,
    });

    // Read broadcast event (with timeout)
    const readWithTimeout = () => Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);

    try {
      const { value } = await readWithTimeout();
      const text = new TextDecoder().decode(value);
      assert.ok(text.includes('event: answer'), 'should receive answer broadcast event');
      assert.ok(text.includes('"team_num":50'), 'broadcast should include team_num');
      assert.ok(text.includes('"version":1'), 'broadcast should include answer version');
    } finally {
      controller.abort();
      reader.releaseLock();
    }
  });
});

// ─── Auth Enforcement ───────────────────────────────────────────────────
describe('Auth enforcement', () => {
  it('POST /api/sheet/template without auth returns 401', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'NoAuth' },
    });
    assert.equal(res.status, 401);
  });

  it('PUT /api/sheet/answer without auth returns 401', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: 1, value: 'PASS' },
    });
    assert.equal(res.status, 401);
  });

  it('POST /api/sheet/template with official cookie returns 403 (chief required)', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'OfficialTry' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
  });
});

// ─── Team-state 수렴형 강제 (구 내부 라이프사이클 라우트 대체) ─────────────
// entry가 이벤트를 push하는 대신, inspection이 team-state 스냅샷을 pull해서 version
// 변경 시 tombstone cascade·비정규화 갱신·비활성 필터를 멱등하게 적용한다.
describe('Team-state convergent enforcement', () => {
  let fake, srv, cli, database, dp, teamState;
  let categoryId, itemId;
  let version = 0;

  const baseTeams = () => ({
    301: { num: 31, univ: 'A대', team: '팀A', type: 'EV', active: true },
    302: { num: 32, univ: 'B대', team: '팀B', type: 'EV', active: true },
  });

  function publish(mutate = (s) => s) {
    version++;
    const snap = mutate({ version, teams: baseTeams(), tombstones: [] });
    snap.version = version;
    fake.setSnapshot(CURRENT_YEAR, snap);
    return teamState.refresh(CURRENT_YEAR);
  }

  before(async () => {
    fake = await startFakeEntryServer();
    process.env.ENTRY_SERVER = fake.url;

    dp = tmpDbPath();
    const result = createInspectionApp({ dbPath: dp, skipTeamStateSync: true, validateUser: TRUST_JWT });
    database = result.db;
    teamState = result.teamState;

    categoryId = database.prepare(
      "INSERT INTO sheet_template (year, level, sort_order, name) VALUES (?, 'category', 0, 'ConvCat')"
    ).run(CURRENT_YEAR).lastInsertRowid;
    itemId = database.prepare(
      "INSERT INTO sheet_template (year, level, parent_id, sort_order, name, answer_type) VALUES (?, 'item', ?, 0, 'ConvItem', 'text')"
    ).run(CURRENT_YEAR, categoryId).lastInsertRowid;

    // 레거시 행: 백필 검증용 — 팀 31의 옛 답변(team_id NULL) + entry가 모르는 번호 99
    database.prepare("INSERT INTO sheet_answer (year, team_num, item_id, value) VALUES (?, 31, ?, 'legacy')")
      .run(CURRENT_YEAR, itemId);
    database.prepare("INSERT INTO sheet_answer (year, team_num, item_id, value) VALUES (?, 99, ?, 'orphan')")
      .run(CURRENT_YEAR, itemId);

    const started = await startServer(result.app);
    srv = started.server;
    cli = createClient(started.baseUrl);
    await publish();
  });

  after(async () => {
    await stopServer(srv);
    await fake.close();
    database.close();
    cleanup(dp);
  });

  it('backfills team_id for legacy rows and leaves unknown teams NULL (never deleted)', () => {
    assert.equal(
      database.prepare("SELECT team_id FROM sheet_answer WHERE year = ? AND team_num = 31").get(CURRENT_YEAR).team_id,
      301,
    );
    const orphan = database.prepare("SELECT team_id, value FROM sheet_answer WHERE year = ? AND team_num = 99").get(CURRENT_YEAR);
    assert.equal(orphan.team_id, null, 'unknown team stays NULL');
    assert.equal(orphan.value, 'orphan', 'unknown team row must not be deleted');
  });

  it('writes adopt the resolved team_id on the num-key upsert', async () => {
    const answer = await cli.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 31, item_id: Number(itemId), value: 'v1' },
      cookie: officialCookie,
    });
    assert.equal(answer.status, 200);
    const catResult = await cli.put('/api/sheet/category-result', {
      body: { year: CURRENT_YEAR, team_num: 31, category_id: Number(categoryId), result: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(catResult.status, 200);
    const inspector = await cli.put('/api/sheet/inspector', {
      body: { year: CURRENT_YEAR, team_num: 31, category_id: Number(categoryId), inspector: 'Insp A' },
      cookie: officialCookie,
    });
    assert.equal(inspector.status, 200);

    assert.deepEqual(
      database.prepare("SELECT team_id, value FROM sheet_answer WHERE year = ? AND team_num = 31").get(CURRENT_YEAR),
      { team_id: 301, value: 'v1' },
    );
    assert.equal(database.prepare("SELECT team_id FROM sheet_category_result WHERE year = ? AND team_num = 31").get(CURRENT_YEAR).team_id, 301);
    assert.equal(database.prepare("SELECT team_id FROM sheet_inspector WHERE year = ? AND team_num = 31").get(CURRENT_YEAR).team_id, 301);
  });

  it('renumber converges: denormalized num follows the immutable id in all 3 tables', async () => {
    await publish((s) => {
      s.teams[301] = { num: 33, univ: 'A대', team: '팀A(정정)', type: 'EV', active: true };
      return s;
    });
    for (const table of ['sheet_answer', 'sheet_category_result', 'sheet_inspector']) {
      assert.equal(
        database.prepare(`SELECT team_num FROM ${table} WHERE year = ? AND team_id = 301`).get(CURRENT_YEAR).team_num,
        33,
        `${table} must follow the id after a renumber`,
      );
    }

    const summary = await (await cli.get(`/api/sheet/summary?year=${CURRENT_YEAR}`, { cookie: officialCookie })).json();
    assert.equal(summary.teams[31], undefined);
    assert.equal(summary.teams[33].results[categoryId], 'PASS');
    assert.equal(summary.teams[33].inspectors[categoryId], 'Insp A');

    const bulk = await (await cli.get(`/api/sheet/bulk-answers?year=${CURRENT_YEAR}&item_ids=${itemId}`, { cookie: officialCookie })).json();
    assert.equal(bulk[31], undefined);
    assert.equal(bulk[33][itemId], 'v1');
  });

  // 회귀: 두 팀이 번호를 맞바꾸면 단일 패스 UPDATE는 (year, team_num, ...) UNIQUE에
  // 걸려 강제 전체가 롤백됐다 — 임시 음수 번호 경유 두 단계로 수렴해야 한다.
  it('two teams swapping numbers converge without UNIQUE collisions', async () => {
    // 팀 302에도 행을 만들어 두 팀 모두 시트 데이터를 가진 상태에서 스왑
    const put = await cli.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 32, item_id: itemId, value: 'v32', base_version: 0 },
      cookie: officialCookie,
    });
    assert.equal(put.status, 200);

    // 직전 테스트에서 301은 num 33 — 301↔302가 32/33을 맞바꾼다
    await publish((s) => {
      s.teams[301] = { num: 32, univ: 'A대', team: '팀A(정정)', type: 'EV', active: true };
      s.teams[302] = { num: 33, univ: 'B대', team: '팀B', type: 'EV', active: true };
      return s;
    });
    assert.equal(database.prepare('SELECT team_num FROM sheet_answer WHERE year = ? AND team_id = 301').get(CURRENT_YEAR).team_num, 32);
    assert.equal(database.prepare('SELECT team_num FROM sheet_answer WHERE year = ? AND team_id = 302').get(CURRENT_YEAR).team_num, 33);

    // 원상 복구 (이후 테스트가 기존 배치를 가정)
    await publish((s) => {
      s.teams[301] = { num: 33, univ: 'A대', team: '팀A(정정)', type: 'EV', active: true };
      s.teams[302] = { num: 32, univ: 'B대', team: '팀B', type: 'EV', active: true };
      return s;
    });
    assert.equal(database.prepare('SELECT team_num FROM sheet_answer WHERE year = ? AND team_id = 301').get(CURRENT_YEAR).team_num, 33);
  });

  it('deactivation hides rows and blocks writes; reactivation restores (idempotent re-run safe)', async () => {
    // 팀 32의 데이터 준비 (활성 상태에서)
    await publish();
    for (const [path, body] of [
      ['/api/sheet/answer', { year: CURRENT_YEAR, team_num: 32, item_id: Number(itemId), value: 'keep32' }],
      ['/api/sheet/category-result', { year: CURRENT_YEAR, team_num: 32, category_id: Number(categoryId), result: 'FAIL' }],
      ['/api/sheet/inspector', { year: CURRENT_YEAR, team_num: 32, category_id: Number(categoryId), inspector: 'Insp B' }],
    ]) {
      assert.equal((await cli.put(path, { body, cookie: officialCookie })).status, 200);
    }

    await publish((s) => { s.teams[302].active = false; return s; });
    const summary = await (await cli.get(`/api/sheet/summary?year=${CURRENT_YEAR}`, { cookie: officialCookie })).json();
    assert.equal(summary.teams[32], undefined, 'inactive team hidden from summary');
    const bulk = await (await cli.get(`/api/sheet/bulk-answers?year=${CURRENT_YEAR}&item_ids=${itemId}`, { cookie: officialCookie })).json();
    assert.equal(bulk[32], undefined, 'inactive team hidden from bulk-answers');
    assert.equal((await cli.get(`/api/sheet/data/${CURRENT_YEAR}/32`, { cookie: officialCookie })).status, 404);
    assert.equal((await cli.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 32, item_id: Number(itemId), value: 'blocked' },
      cookie: officialCookie,
    })).status, 409, 'writes to an inactive team are rejected');
    assert.equal(
      database.prepare("SELECT value FROM sheet_answer WHERE year = ? AND team_num = 32").get(CURRENT_YEAR).value,
      'keep32',
      'deactivation must preserve data',
    );

    // 같은 스냅샷 재적용(멱등) 후 재활성화
    await teamState.refresh(CURRENT_YEAR);
    await publish();
    const restored = await (await cli.get(`/api/sheet/data/${CURRENT_YEAR}/32`, { cookie: officialCookie })).json();
    assert.equal(restored.answers[itemId].value, 'keep32', 'reactivation restores preserved data');
  });

  it('tombstones cascade-delete the team rows by id in all 3 tables', async () => {
    await publish((s) => {
      delete s.teams[302];
      s.tombstones = [{ id: 302, num: 32, deleted_at: '2026-01-01T00:00:00.000Z' }];
      return s;
    });
    for (const table of ['sheet_answer', 'sheet_category_result', 'sheet_inspector']) {
      assert.equal(
        database.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE year = ? AND team_id = 302`).get(CURRENT_YEAR).c,
        0,
        `${table} rows must be cascade-deleted`,
      );
    }
    // 모르는 팀(99)은 여전히 보존
    assert.equal(database.prepare("SELECT COUNT(*) AS c FROM sheet_answer WHERE year = ? AND team_num = 99").get(CURRENT_YEAR).c, 1);
  });

  it('unknown teams stay writable (fail-open, no entry dependency) and are never deleted', async () => {
    // score와 달리 inspection 쓰기는 entry 의존이 없다 — 미지의 번호도 num 키로 저장된다
    // (기존 absent-row-means-active 시맨틱 유지). team_id는 NULL로 남는다.
    const res = await cli.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 99, item_id: Number(itemId), value: 'orphan2' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    const row = database.prepare("SELECT team_id, value FROM sheet_answer WHERE year = ? AND team_num = 99").get(CURRENT_YEAR);
    assert.deepEqual(row, { team_id: null, value: 'orphan2' });
  });
});
